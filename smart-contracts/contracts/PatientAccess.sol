// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/* ---------------- ERC20 minimal ---------------- */
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function decimals() external view returns (uint8);
}

/* ---------------- ReentrancyGuard ---------------- */
abstract contract ReentrancyGuard {
    uint256 private _status = 1;
    modifier nonReentrant() {
        require(_status == 1, "REENTRANT");
        _status = 2;
        _;
        _status = 1;
    }
}

/* =================================================
 *                 PatientAccess
 * ================================================= */
contract PatientAccess is ReentrancyGuard {
    /* ------------ Types ------------ */
    enum Mode { READ, COPY }
    enum Status { REQUESTED, PATIENT_APPROVED, FULFILLED, EXPIRED, CANCELED }

    struct Clinic {
        bool registered;
        string clinicId;      // display only
        address payout;       // settlement address
        address operator;     // worker/operator
    }

    struct Price {
        address token;        // ERC20
        uint256 readPrice;    // flat price
        uint256 copyPrice;    // flat price
        bool set;
    }

    struct AccessRequest {
        uint256 id;
        address patient;
        bytes32 providerClinicKey;   // provider (other clinic)
        bytes32 requesterClinicKey;  // requester (our clinic)
        Mode mode;
        address token;
        uint256 price;
        Status status;
        bytes32 manifestHash;        // proof of fulfillment
    }

    struct AccessBatch {
        uint256 batchId;
        address patient;
        bytes32 requesterClinicKey;
        Mode mode;
        uint256[] childIds;
        uint256 totalPrice;
        address token;
        bool exists;
    }

    /* ------------ Storage ------------ */
    // patient => (clinicKey => aliasHash)  (PII stays off-chain)
    mapping(address => mapping(bytes32 => bytes32)) public patientAlias;

    mapping(bytes32 => Clinic) public clinics; // clinicKey => Clinic
    mapping(bytes32 => Price)  public prices;  // providerClinicKey => Price

    mapping(uint256 => AccessRequest) public reqs;
    uint256 public nextReqId;

    mapping(uint256 => AccessBatch) public batches;
    uint256 public nextBatchId;

    /* ------------ Events ------------ */
    event ClinicRegistered(bytes32 indexed clinicKey, string clinicId, address payout, address operator);
    event ClinicUpdated(bytes32 indexed clinicKey, address payout, address operator);
    event PriceSet(bytes32 indexed providerClinicKey, address token, uint256 readPrice, uint256 copyPrice);

    event PatientAliasLinked(address indexed patient, bytes32 indexed clinicKey, bytes32 aliasHash);

    event AccessRequested(
        uint256 indexed id,
        address indexed patient,
        bytes32 indexed providerClinicKey,
        bytes32 requesterClinicKey,
        Mode mode,
        address token,
        uint256 price
    );
    event PatientApproved(uint256 indexed id);
    event AccessFulfilled(uint256 indexed id, bytes32 manifestHash);
    event AccessCanceled(uint256 indexed id);
    event AccessExpired(uint256 indexed id);

    event AccessBatchCreated(uint256 indexed batchId, uint256[] childIds, uint256 totalPrice, address token);

    /* ------------ Internals ------------ */
    function _ckey(string memory clinicId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(clinicId));
    }

    function _onlyClinic(bytes32 clinicKey) internal view {
        require(clinics[clinicKey].registered, "CLINIC_NOT_REGISTERED");
        require(clinics[clinicKey].payout != address(0), "CLINIC_PAYOUT_ZERO");
    }

    function _onlyProvider(bytes32 clinicKey) internal view {
        _onlyClinic(clinicKey);
        require(
            msg.sender == clinics[clinicKey].payout || msg.sender == clinics[clinicKey].operator,
            "NOT_PROVIDER_OPERATOR"
        );
    }

    function _onlyRequester(bytes32 clinicKey) internal view {
        _onlyClinic(clinicKey);
        require(
            msg.sender == clinics[clinicKey].payout || msg.sender == clinics[clinicKey].operator,
            "NOT_REQUESTER_OPERATOR"
        );
    }

    /* ------------ Clinic registry ------------ */
    function registerClinic(string calldata clinicId, address payout, address operator) external {
        bytes32 key = _ckey(clinicId);
        clinics[key].registered = true;
        clinics[key].clinicId  = clinicId;
        clinics[key].payout    = (payout == address(0)) ? msg.sender : payout;
        clinics[key].operator  = operator;
        emit ClinicRegistered(key, clinicId, clinics[key].payout, clinics[key].operator);
    }

    function updateClinic(string calldata clinicId, address payout, address operator) external {
        bytes32 key = _ckey(clinicId);
        _onlyClinic(key);
        require(
            msg.sender == clinics[key].payout || msg.sender == clinics[key].operator,
            "NOT_AUTH_FOR_UPDATE"
        );
        if (payout != address(0)) clinics[key].payout = payout;
        clinics[key].operator = operator;
        emit ClinicUpdated(key, clinics[key].payout, clinics[key].operator);
    }

    /* ------------ Price table (by provider) ------------ */
    function setPrice(string calldata providerClinicId, address token, uint256 readPrice, uint256 copyPrice) external {
        bytes32 pkey = _ckey(providerClinicId);
        _onlyProvider(pkey);
        prices[pkey] = Price({ token: token, readPrice: readPrice, copyPrice: copyPrice, set: true });
        emit PriceSet(pkey, token, readPrice, copyPrice);
    }

    /* ------------ Patient alias link (no PII on-chain) ------------ */
    function setPatientAlias(string calldata clinicId, bytes32 aliasHash) external {
        bytes32 key = _ckey(clinicId);
        require(clinics[key].registered, "CLINIC_UNKNOWN");
        patientAlias[msg.sender][key] = aliasHash; // only patient (msg.sender)
        emit PatientAliasLinked(msg.sender, key, aliasHash);
    }

    /* ------------ Single request ------------ */
    function requestPatientAccess(
        address patient,
        string calldata providerClinicId,
        string calldata requesterClinicId,
        Mode mode
    ) external nonReentrant returns (uint256 id) {
        bytes32 prov = _ckey(providerClinicId);
        bytes32 reqr = _ckey(requesterClinicId);
        _onlyRequester(reqr);
        require(clinics[prov].registered, "PROVIDER_UNKNOWN");

        Price memory pr = prices[prov];
        require(pr.set, "PRICE_NOT_SET");
        address token = pr.token;
        uint256 price = (mode == Mode.READ) ? pr.readPrice : pr.copyPrice;
        require(price > 0, "PRICE_ZERO");

        // requester deposits to escrow
        require(IERC20(token).transferFrom(msg.sender, address(this), price), "ESCROW_TRANSFER_FAIL");

        id = ++nextReqId;
        reqs[id] = AccessRequest({
            id: id,
            patient: patient,
            providerClinicKey: prov,
            requesterClinicKey: reqr,
            mode: mode,
            token: token,
            price: price,
            status: Status.REQUESTED,
            manifestHash: bytes32(0)
        });

        emit AccessRequested(id, patient, prov, reqr, mode, token, price);
    }

    /* ------------ Patient approval ------------ */
    function approveByPatient(uint256 id) external {
        AccessRequest storage r = reqs[id];
        require(r.id == id, "REQ_UNKNOWN");
        require(r.status == Status.REQUESTED, "BAD_STATUS");
        require(msg.sender == r.patient, "NOT_PATIENT");
        r.status = Status.PATIENT_APPROVED;
        emit PatientApproved(id);
    }

    /* ------------ Fulfillment & settlement ------------ */
    function markFulfilled(uint256 id, bytes32 manifestHash) external nonReentrant {
        AccessRequest storage r = reqs[id];
        require(r.id == id, "REQ_UNKNOWN");
        require(r.status == Status.PATIENT_APPROVED, "NOT_APPROVED");
        _onlyProvider(r.providerClinicKey);
        r.status = Status.FULFILLED;
        r.manifestHash = manifestHash;
        emit AccessFulfilled(id, manifestHash);
        require(IERC20(r.token).transfer(clinics[r.providerClinicKey].payout, r.price), "PAYOUT_FAIL");
    }

    /* ------------ Expire / Cancel (refund to requester) ------------ */
    function expire(uint256 id) external nonReentrant {
        AccessRequest storage r = reqs[id];
        require(r.id == id, "REQ_UNKNOWN");
        require(r.status == Status.REQUESTED || r.status == Status.PATIENT_APPROVED, "BAD_STATUS");
        _onlyRequester(r.requesterClinicKey);
        r.status = Status.EXPIRED;
        emit AccessExpired(id);
        require(IERC20(r.token).transfer(clinics[r.requesterClinicKey].payout, r.price), "REFUND_FAIL");
    }

    function cancel(uint256 id) external nonReentrant {
        AccessRequest storage r = reqs[id];
        require(r.id == id, "REQ_UNKNOWN");
        require(r.status == Status.REQUESTED || r.status == Status.PATIENT_APPROVED, "BAD_STATUS");
        require(
            msg.sender == r.patient ||
            msg.sender == clinics[r.requesterClinicKey].payout ||
            msg.sender == clinics[r.requesterClinicKey].operator,
            "NOT_AUTH_CANCEL"
        );
        r.status = Status.CANCELED;
        emit AccessCanceled(id);
        require(IERC20(r.token).transfer(clinics[r.requesterClinicKey].payout, r.price), "REFUND_FAIL");
    }

    /* ------------ Batch (bundle multiple providers) ------------ */
    function createAccessBatch(
        address patient,
        string calldata requesterClinicId,
        string[] calldata providerClinicIds,
        Mode mode
    ) external nonReentrant returns (uint256 batchId, uint256[] memory childIds, uint256 totalPrice, address token) {
        bytes32 reqr = _ckey(requesterClinicId);
        _onlyRequester(reqr);
        require(providerClinicIds.length > 0, "EMPTY_PROVIDERS");

        childIds = new uint256[](providerClinicIds.length);
        totalPrice = 0;
        address token0 = address(0);

        for (uint256 i = 0; i < providerClinicIds.length; i++) {
            bytes32 prov = _ckey(providerClinicIds[i]);
            require(clinics[prov].registered, "PROVIDER_UNKNOWN");
            Price memory pr = prices[prov];
            require(pr.set, "PRICE_NOT_SET");
            address t = pr.token;
            uint256 p = (mode == Mode.READ) ? pr.readPrice : pr.copyPrice;
            require(p > 0, "PRICE_ZERO");
            if (i == 0) token0 = t; else require(t == token0, "TOKEN_MISMATCH");

            uint256 id = ++nextReqId;
            reqs[id] = AccessRequest({
                id: id,
                patient: patient,
                providerClinicKey: prov,
                requesterClinicKey: reqr,
                mode: mode,
                token: t,
                price: p,
                status: Status.REQUESTED,
                manifestHash: bytes32(0)
            });
            emit AccessRequested(id, patient, prov, reqr, mode, t, p);
            childIds[i] = id;
            totalPrice += p;
        }

        require(IERC20(token0).transferFrom(msg.sender, address(this), totalPrice), "BATCH_ESCROW_FAIL");

        batchId = ++nextBatchId;
        batches[batchId] = AccessBatch({
            batchId: batchId,
            patient: patient,
            requesterClinicKey: reqr,
            mode: mode,
            childIds: childIds,
            totalPrice: totalPrice,
            token: token0,
            exists: true
        });

        emit AccessBatchCreated(batchId, childIds, totalPrice, token0);
        token = token0; // return value
    }
}
