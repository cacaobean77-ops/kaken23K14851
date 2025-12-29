# Access Control Flow

This document outlines the interaction flow between the Patient, Blockchain, Worker, and Requester during the medical image access process.

```mermaid
sequenceDiagram
    autonumber
    participant P as Patient
    participant RQ as Requester (Clinic)
    participant SC as Smart Contract (PatientAccess)
    participant W as Worker (Provider)
    participant O_P as Orthanc (Provider)
    participant O_RQ as Orthanc (Requester)

    Note over RQ, SC: 1. Request Access
    RQ->>SC: requestAccess(patient, cid, purpose)
    SC-->>W: Emit AccessRequested

    Note over P, SC: 2. Approve Access
    P->>SC: approveRequest(requestId)
    SC-->>W: Emit AccessApproved

    Note over W: 3. Worker Automation (Pull Mode)
    loop Monitor Events
        W->>SC: Listen for AccessApproved
    end
    W->>W: Verify requestId & Permissions
    W->>O_P: QIDO Search (StudyInstanceUID)
    O_P-->>W: Study Metadata
    W->>O_P: WADO Retrieve (Get Images)
    O_P-->>W: DICOM Files
    W->>O_RQ: Store via DICOM Web (STOW-RS) / Dicom Protocol
    O_RQ-->>W: Success

    Note over W, SC: 4. Finalize
    W->>SC: markFulfilled(requestId)
    SC-->>RQ: Emit RequestFulfilled
    
    Note over RQ: 5. Visualization
    RQ->>O_RQ: View Images (OHIF)
```

## Description

1.  **Request**: Requester initiates a request on-chain.
2.  **Approval**: Patient signs a transaction to approve specific access.
3.  **Fulfillment**:
    *   Provider's Worker detects the approval event.
    *   Worker fetches DICOM data from Provider's Orthanc.
    *   Worker pushes data to Requester's Orthanc (or pulls if configured differently).
    *   Worker records the transfer in an internal audit log and potentially on-chain via `markFulfilled`.
4.  **Completion**: The cycle ends when the smart contract is updated with the fulfillment status.
