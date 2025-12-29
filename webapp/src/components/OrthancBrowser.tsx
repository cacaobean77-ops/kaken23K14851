import React, { useEffect, useState } from "react";
import { listPatientIds, getPatientDetail, getStudyDetail, ohifUrlForStudyUID, OrthancId } from "../lib/orthanc";
import { useContract } from "../hooks/usePatientAccess";

type PatientRow = {
  id: OrthancId;
  pid?: string;
  name?: string;
  studies?: { id: OrthancId; uid?: string; date?: string; desc?: string }[];
  open?: boolean;
};

interface Props {
  contractAddress: string;
}

export default function OrthancBrowser({ contractAddress }: Props) {
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState("");
  const { contract, address: myAddress } = useContract(contractAddress);

  const refresh = async () => {
    if (!requestId.trim()) {
      setError("Request ID を入力してください");
      setPatients([]);
      return;
    }
    setError(null);
    setLoading(true);
    setPatients([]);

    try {
      // Access Control: Check if I am the requester
      if (contract && myAddress) {
        try {
          console.log("Checking requester for reqId:", requestId);
          // reqs(id) -> { requester, requesterClinicKey, ... }
          const req = await contract.reqs(requestId);
          if (!req || req.requester === "0x0000000000000000000000000000000000000000") {
            throw new Error("Request ID not found on-chain");
          }

          // Note: In PatientAccess.sol, 'requester' is the wallet address of the requester.
          // If the user is using an operator wallet (Clinic), we might need to check clinic.operator.

          const clinicKey = req.requesterClinicKey;
          const clinicInfo = await contract.clinics(clinicKey);

          // Safer access to properties
          const reqRequester = (req.requester || "").toString();
          const operator = (clinicInfo.operator || "").toString();

          console.log("Access Check:", { myAddress, reqRequester, operator });

          // Allow if myAddress matches the requester field OR the operator of the clinic
          const isRequester = (myAddress.toLowerCase() === reqRequester.toLowerCase());
          const isOperator = (myAddress.toLowerCase() === operator.toLowerCase());

          if (!isRequester && !isOperator) {
            throw new Error("You are not the authorized requester for this request.");
          }

        } catch (err: any) {
          // If contract call fails or check fails
          console.error("Access check failed", err);
          throw new Error(err.message || "Access verification failed");
        }
      }

      const ids = await listPatientIds(requestId);
      setPatients(ids.map((id) => ({ id })));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (requestId.trim()) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, contract, myAddress]); // Add dependencies

  const togglePatient = async (p: PatientRow) => {
    if (!requestId.trim()) {
      setError("Request ID を入力してください");
      return;
    }
    const idx = patients.findIndex((x) => x.id === p.id);
    if (idx < 0) return;

    // 閉 -> 開：詳細をロード
    if (!patients[idx].open) {
      const detail = await getPatientDetail(p.id, requestId);
      const pid = detail.MainDicomTags?.PatientID;
      const name = detail.MainDicomTags?.PatientName;

      const studies: PatientRow["studies"] = [];
      for (const sid of detail.Studies || []) {
        const sd = await getStudyDetail(sid, requestId);
        const uid = sd.MainDicomTags?.StudyInstanceUID;
        const date = sd.MainDicomTags?.StudyDate;
        const desc = sd.MainDicomTags?.StudyDescription;
        studies.push({ id: sid, uid, date, desc });
      }

      const next = [...patients];
      next[idx] = { ...next[idx], pid, name, studies, open: true };
      setPatients(next);
    } else {
      // 開 -> 閉
      const next = [...patients];
      next[idx] = { ...next[idx], open: false };
      setPatients(next);
    }
  };

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">Requester Orthanc ブラウザ</h2>
        <button onClick={refresh} className="border px-3 py-1 rounded" disabled={!requestId.trim()}>
          再読込
        </button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="text-sm">
          <span className="font-medium">Request ID</span>
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={requestId}
            onChange={(e) => setRequestId(e.target.value)}
            placeholder="例: 1"
          />
        </label>
        <p className="text-xs text-slate-600">
          患者承認済みの Request ID を入力すると、そのリクエストで取得済みのデータのみが表示されます。
        </p>
      </div>
      {loading && <div>読み込み中…</div>}
      {error && <div className="text-red-600 text-sm">{error}</div>}

      <div className="space-y-2">
        {patients.map((p) => (
          <div key={p.id} className="border rounded p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <div className="font-mono">OrthancPatientID: {p.id}</div>
                <div>PatientID: {p.pid ?? "—"} / Name: {p.name ?? "—"}</div>
              </div>
              <button className="border px-2 py-1 rounded" onClick={() => togglePatient(p)}>
                {p.open ? "閉じる" : "開く"}
              </button>
            </div>

            {p.open && (
              <div className="mt-3 space-y-2">
                {p.studies?.length ? (
                  p.studies.map((s) => (
                    <div key={s.id} className="flex items-center justify-between border rounded p-2">
                      <div className="text-sm">
                        <div className="font-mono">StudyOrthancID: {s.id}</div>
                        <div>StudyUID: {s.uid ?? "—"}</div>
                        <div>Date: {s.date ?? "—"} / Desc: {s.desc ?? "—"}</div>
                      </div>
                      <div className="flex gap-2 items-center">
                        {s.uid && (
                          <>
                            <a
                              className="underline text-blue-600 text-xs"
                              href={ohifUrlForStudyUID(s.uid, requestId)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              OHIF Viewer
                            </a>
                            <span className="text-gray-300">|</span>
                            {/* Link to native Orthanc Explorer */}
                            <a
                              className="underline text-blue-600 text-xs"
                              href={`http://localhost:8042/app/explorer.html#study?uuid=${s.id}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Orthanc Explorer
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm opacity-70">Studyはありません。</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
