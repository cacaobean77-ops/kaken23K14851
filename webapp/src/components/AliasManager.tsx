import React, { useEffect, useMemo, useState } from "react";

const WORKER_API = import.meta.env.VITE_WORKER_API as string | undefined;

type AliasEntry = {
  address: string;
  patientId: string;
};

type ApiResponse = {
  aliases: Record<string, string>;
};

function normaliseAddress(addr: string): string {
  const trimmed = addr.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return trimmed;
  return trimmed;
}

export default function AliasManager() {
  const [aliases, setAliases] = useState<AliasEntry[]>([]);
  const [walletAddr, setWalletAddr] = useState("");
  const [patientId, setPatientId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const endpoint = useMemo(() => (WORKER_API ? WORKER_API.replace(/\/+$/, "") : null), []);

  const load = async () => {
    if (!endpoint) return;
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(`${endpoint}/aliases`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: ApiResponse = await res.json();
      const entries = Object.entries(data.aliases || {}).map(([address, pid]) => ({
        address,
        patientId: String(pid ?? ""),
      }));
      setAliases(entries);
    } catch (err: any) {
      setStatus(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!endpoint) return;
    load();
  }, [endpoint]);

  if (!endpoint) {
    return (
      <div className="p-4 space-y-2">
        <h2 className="text-xl font-bold">患者IDエイリアス管理</h2>
        <div className="text-sm opacity-70">
          VITE_WORKER_API が設定されていないため、エイリアス管理 UI は利用できません。
        </div>
      </div>
    );
  }

  const submit = async () => {
    const addr = normaliseAddress(walletAddr);
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setStatus("ウォレットアドレスの形式が不正です。");
      return;
    }
    if (!patientId.trim()) {
      setStatus("患者IDを入力してください。");
      return;
    }

    try {
      setStatus("送信中...");
      const res = await fetch(`${endpoint}/aliases`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr, patientId: patientId.trim() }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      setWalletAddr("");
      setPatientId("");
      await load();
      setStatus("登録しました");
    } catch (err: any) {
      setStatus(err?.message || String(err));
    }
  };

  const remove = async (addr: string) => {
    try {
      setStatus("削除中...");
      const res = await fetch(`${endpoint}/aliases/${encodeURIComponent(addr)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      await load();
      setStatus("削除しました");
    } catch (err: any) {
      setStatus(err?.message || String(err));
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold">患者IDエイリアス管理</h2>
        <button className="border px-3 py-1 rounded" onClick={load} disabled={loading}>
          再読込
        </button>
      </div>

      <div className="grid gap-2 max-w-xl">
        <input
          className="border p-2"
          placeholder="ウォレットアドレス (0x...)"
          value={walletAddr}
          onChange={(e) => setWalletAddr(e.target.value)}
        />
        <input
          className="border p-2"
          placeholder="患者ID"
          value={patientId}
          onChange={(e) => setPatientId(e.target.value)}
        />
        <button className="border px-3 py-2 rounded" onClick={submit} disabled={loading}>
          登録 / 更新
        </button>
      </div>

      {status && <div className="text-sm opacity-80">{status}</div>}

      <table className="w-full text-sm border">
        <thead className="bg-gray-100">
          <tr>
            <th className="px-2 py-1 text-left">ウォレット</th>
            <th className="px-2 py-1 text-left">患者ID</th>
            <th className="px-2 py-1 text-left">操作</th>
          </tr>
        </thead>
        <tbody>
          {aliases.map((entry) => (
            <tr key={entry.address}>
              <td className="border-t px-2 py-1 font-mono">{entry.address}</td>
              <td className="border-t px-2 py-1">{entry.patientId}</td>
              <td className="border-t px-2 py-1">
                <button className="border px-2 py-1 rounded" onClick={() => remove(entry.address)} disabled={loading}>
                  削除
                </button>
              </td>
            </tr>
          ))}
          {aliases.length === 0 && (
            <tr>
              <td className="border-t px-2 py-2 text-center text-sm opacity-70" colSpan={3}>
                登録済みのエイリアスはありません。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
