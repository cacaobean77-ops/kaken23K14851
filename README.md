# Blockchain-based Patient Consent and DICOM Access System (PoC)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

This repository contains the Proof of Concept (PoC) implementation for a blockchain-based medical imaging (DICOM) access control system. It demonstrates how patient consent recorded on an Ethereum-based blockchain can trigger secure, auditable, and automated DICOM image transfers between healthcare providers (Orthanc PACS).

**Key Features:**
- **Patient Sovereignty**: Patients initiate/approve access requests via a DApp.
- **Automated Fulfillment**: Off-chain workers listen to blockchain events and execute DICOM transfers.
- **Auditability**: All access requests and fulfillments are recorded on-chain; gateway access is logged.
- **Standard Compliance**: Uses DICOMweb standards (QIDO-RS, WADO-RS).

## Architecture

```mermaid
graph TD
    User[Patient/Requester] -->|Approve/Request| DApp[React WebApp]
    DApp -->|Tx| SC[Smart Contract (PatientAccess.sol)]
    
    Worker[Node.js Worker] -- Watch Events --> SC
    Worker -- 1. Pull/Push Images --> SourcePACS[Provider Orthanc]
    Worker -- 2. Store Images --> DestPACS[Requester Orthanc]
    Worker -- 3. Mark Fulfilled --> SC
    
    Viewer[OHIF Viewer] --> Gateway[Worker Gateway]
    Gateway -->|AuthZ Check| DestPACS
```

## Quickstart

### Prerequisites
- Docker & Docker Compose
- Node.js (v20+)
- MetaMask (browser extension)

### Setup & Run
1.  **Install Dependencies**:
    ```bash
    ./setup_first.sh
    ```
2.  **Start System**:
    ```bash
    ./start_stack.sh
    ```
    This launches:
    - Hardhat Node (Local Blockchain)
    - Orthanc PACS (Provider & Requester)
    - Worker Service
    - Web Application (http://localhost:5173)

3.  **Stop**:
    ```bash
    ./stop_stack.sh
    ```

## Configuration

Environment variables are managed via `.env` files. See `.env.example` for details.

### Key Variables
| Variable | Description |
|----------|-------------|
| `VITE_CONTRACT` | Address of the deployed PatientAccess contract |
| `VITE_WORKER_API` | URL of the Worker service (default: http://localhost:8787) |
| `VITE_ORTHANC_BASE_RQ` | Base URL for the Requester Orthanc (via proxy) |

For the Worker, see `worker/config.example.json`.

## Reproducibility

To reproduce the experimental flow described in the paper:

1.  **Login**: Open http://localhost:5173. Use the "Requester Dashboard".
2.  **Request**: Create a new request for a patient (e.g., using a test wallet address).
3.  **Approve**: Switch to the "Patient" tab (or use a different browser profile with the Patient wallet) and approve the request.
4.  **Verify**: Watch the "Worker Progress" in the dashboard. The system will automatically move the DICOM study from Provider to Requester PACS.
5.  **View**: Click "View Images" to open the OHIF Viewer.

## Security & Privacy

- **PHI Protection**: No Patient Health Information (PHI) is stored on the blockchain. Only pseudonymous identifiers and hash verification proofs are on-chain.
- **Secret Management**: **Do not use default credentials in production.** The repository uses `orthanc:orthanc` and `admin:admin` for local demonstration purposes only.
- **Audit Logs**: The Worker maintains a `gateway-audit.jsonl` file (and optionally encrypts it) to track all accesses to the DICOM gateway.

## Citation

If you use this code for your research, please cite our paper:

```bibtex
@software{tajima2025blockchain,
  author = {Tajima, Yuu},
  title = {Blockchain-based Patient Consent and DICOM Access System},
  year = {2025},
  url = {https://github.com/cacaobean77-ops/kaken23K14851}
}
```

See `CITATION.cff` for more details.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
