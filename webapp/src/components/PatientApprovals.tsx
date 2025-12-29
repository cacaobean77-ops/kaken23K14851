import React, { useState } from "react";
import { useContract } from "../hooks/usePatientAccess";

export default function PatientApprovals({ contractAddress }: { contractAddress: string }) {
  const { contract } = useContract(contractAddress);
  const [reqId, setReqId] = useState("");
  const [status, setStatus] = useState<string>("");

  const setTxStatus = (msg: string) => setStatus(msg);

  const withTx = async (fn: () => Promise<any>, success: string) => {
    if (!contract) return;
    if (!reqId.trim()) {
      setTxStatus("申請IDを入力してください");
      return;
    }
    setTxStatus("送信中...");
    try {
      const tx = await fn();
      setTxStatus("承認待ち (MetaMask) ...");
      await tx.wait();
      setTxStatus(success);
    } catch (e: any) {
      const reason = e?.error?.reason || e?.info?.error?.message || e?.reason || e?.message || String(e);
      setTxStatus(`エラー: ${reason}`);
    }
  };

  const approve = async () => withTx(() => contract!.approveByPatient(Number(reqId)), "承認しました");
  const cancel = async () => withTx(() => contract!.cancel(Number(reqId)), "キャンセルしました");

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">患者ポータル（承認/拒否）</h2>
      <div className="grid gap-2">
        <input
          className="border p-2"
          placeholder="申請ID (reqId)"
          value={reqId}
          onChange={(e) => setReqId(e.target.value)}
        />
        <div className="flex gap-2">
          <button className="border px-3 py-2 rounded" onClick={approve}>
            承認
          </button>
          <button className="border px-3 py-2 rounded" onClick={cancel}>
            拒否
          </button>
        </div>
      </div>
      {status && <div className="text-sm opacity-80">{status}</div>}
    </div>
  );
}
