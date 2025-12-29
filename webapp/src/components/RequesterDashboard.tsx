import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { useContract } from "../hooks/usePatientAccess";
import { clinicKey, checksum, canonical } from "../lib/clinic";

const STATUS_LABELS = [
  "REQUESTED",
  "PATIENT_APPROVED",
  "FULFILLED",
  "EXPIRED",
  "CANCELED",
];

const MODE_LABELS = ["READ", "COPY"];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

type ProviderPricing = {
  token: string;
  readPrice: bigint;
  copyPrice: bigint;
  set: boolean;
};

type TokenMeta = {
  symbol: string;
  decimals: number;
};

type TokenBalance = {
  allowance: bigint;
  balance: bigint;
};

type ChildRow = {
  id: string;
  providerKey: string;
  providerLabel: string;
  status: string;
  price: bigint;
  token: string;
  manifestHash: string;
};

type BatchRow = {
  batchId: string;
  mode: string;
  totalPrice: bigint;
  token: string;
  child: ChildRow[];
};

type CopyEventFailure = {
  sop: string;
  message: string;
};

type CopyEventSummary = {
  requestId: number;
  providerId?: string;
  patientAddress: string;
  patientId: string;
  total: number;
  success: number;
  failed: number;
  status: "pending" | "copying" | "completed" | "partial" | "error";
  errors: string[];
  failures: CopyEventFailure[];
  manifestHash?: string;
  startedAt: string;
  updatedAt: string;
};

const COPY_EVENT_STATUS_LABELS: Record<CopyEventSummary["status"], string> = {
  pending: "待機中",
  copying: "コピー中",
  completed: "完了",
  partial: "一部失敗",
  error: "エラー",
};

function toBigIntSafe(value: any): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && typeof value.toString === "function") {
    try {
      return BigInt(value.toString());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function formatAmount(amount: bigint, token: string, meta: Record<string, TokenMeta>): string {
  const key = canonical(token);
  const info = meta[key];
  if (!info) return `${amount.toString()} wei`;
  try {
    return `${ethers.formatUnits(amount, info.decimals)} ${info.symbol}`;
  } catch {
    return `${amount.toString()} (raw)`;
  }
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  } catch {
    return value;
  }
}

export default function RequesterDashboard({ contractAddress }: { contractAddress: string }) {
  const { contract, signer, address } = useContract(contractAddress);

  const [patient, setPatient] = useState("");
  const [aliasMap, setAliasMap] = useState<Record<string, string>>({});
  const [aliasStatus, setAliasStatus] = useState<string | null>(null);
  const [requesterClinicId, setRequesterClinicId] = useState("REQ-001");
  const [providers, setProviders] = useState<string[]>([]);
  const [mode, setMode] = useState<number>(0);
  const [pendingTx, setPendingTx] = useState<string | null>(null);
  const [lastReqId, setLastReqId] = useState<string>("");

  const [pricing, setPricing] = useState<Record<string, ProviderPricing>>({});
  const [tokenMeta, setTokenMeta] = useState<Record<string, TokenMeta>>({});
  const [tokenBalances, setTokenBalances] = useState<Record<string, TokenBalance>>({});
  const [providerNames, setProviderNames] = useState<Record<string, string>>({});
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [copyEvents, setCopyEvents] = useState<CopyEventSummary[]>([]);
  const [copyEventError, setCopyEventError] = useState<string | null>(null);

  const addProvider = (id: string) =>
    setProviders((prev) => {
      const value = (id || "").trim();
      if (!value) return prev;
      if (prev.includes(value)) return prev;
      return [...prev, value];
    });

  const removeProvider = (id: string) =>
    setProviders((prev) => prev.filter((v) => v !== id));

  const trackedTokens = useMemo(() => {
    const set = new Set<string>();
    for (const info of Object.values(pricing)) {
      if (info.token) set.add(checksum(info.token));
    }
    for (const batch of batches) {
      if (batch.token) set.add(checksum(batch.token));
      for (const child of batch.child) {
        if (child.token) set.add(checksum(child.token));
      }
    }
    return Array.from(set.values());
  }, [pricing, batches]);

  const alertEvents = useMemo(
    () => copyEvents.filter((event) => event.status === "partial" || event.status === "error"),
    [copyEvents]
  );

  const recentCopyEvents = useMemo(() => copyEvents.slice(0, 8), [copyEvents]);

  const workerEndpoint = useMemo(() => {
    const raw = import.meta.env.VITE_WORKER_API as string | undefined;
    return raw ? raw.replace(/\/+$/, "") : null;
  }, []);

  useEffect(() => {
    if (!workerEndpoint) return;
    let cancelled = false;

    const fetchAliases = async () => {
      try {
        const res = await fetch(`${workerEndpoint}/aliases`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { aliases?: Record<string, string> } = await res.json();
        if (!cancelled) {
          setAliasMap(data.aliases ?? {});
          setAliasStatus(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setAliasStatus(err?.message || String(err));
        }
      }
    };

    fetchAliases();
    const timer = setInterval(fetchAliases, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workerEndpoint]);

  useEffect(() => {
    if (!workerEndpoint) return;
    let cancelled = false;

    const fetchCopyEvents = async () => {
      try {
        const res = await fetch(`${workerEndpoint}/copy-events`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { events?: CopyEventSummary[] } = await res.json();
        if (!cancelled) {
          setCopyEvents(Array.isArray(data.events) ? data.events : []);
          setCopyEventError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setCopyEventError(err?.message || String(err));
        }
      }
    };

    fetchCopyEvents();
    const timer = setInterval(fetchCopyEvents, 7000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workerEndpoint]);

  const patientResolution = useMemo(() => {
    const value = patient.trim();
    if (!value) return { address: "", status: "none" as const };
    if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
      try {
        return { address: ethers.getAddress(value), status: "wallet" as const };
      } catch {
        return { address: "", status: "invalid" as const };
      }
    }
    for (const [wallet, pid] of Object.entries(aliasMap)) {
      if (pid === value) {
        try {
          return { address: ethers.getAddress(wallet), status: "alias" as const };
        } catch {
          return { address: "", status: "invalid" as const };
        }
      }
    }
    return { address: "", status: "unresolved" as const };
  }, [patient, aliasMap]);

  const canSubmit = useMemo(() => {
    return (
      !!contract &&
      !!patientResolution.address &&
      requesterClinicId.trim().length > 0 &&
      providers.length > 0
    );
  }, [contract, patientResolution.address, requesterClinicId, providers.length]);

  const refreshPricing = useCallback(async () => {
    if (!contract || !signer || providers.length === 0) return;

    const priceUpdates: Record<string, ProviderPricing> = {};
    const metaUpdates: Record<string, TokenMeta> = {};
    const nameUpdates: Record<string, string> = {};

    for (const providerId of providers) {
      const key = clinicKey(providerId);
      if (!key) continue;

      try {
        const price = await contract.prices(key);
        if (!price?.set) {
          priceUpdates[providerId] = {
            token: "",
            readPrice: 0n,
            copyPrice: 0n,
            set: false,
          };
          continue;
        }

        const tokenAddress = checksum(price.token);
        priceUpdates[providerId] = {
          token: tokenAddress,
          readPrice: toBigIntSafe(price.readPrice),
          copyPrice: toBigIntSafe(price.copyPrice),
          set: true,
        };

        const tokenKey = canonical(tokenAddress);
        if (!tokenMeta[tokenKey]) {
          const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
          let symbol = tokenAddress.slice(0, 6) + "…";
          let decimals = 18;
          try {
            symbol = await erc20.symbol();
          } catch {
            // ignore
          }
          try {
            decimals = Number(await erc20.decimals());
          } catch {
            // ignore
          }
          metaUpdates[tokenKey] = { symbol, decimals };
        }

        if (!providerNames[key]) {
          const clinic = await contract.clinics(key);
          if (clinic?.registered) {
            nameUpdates[key] = clinic.clinicId || providerId;
          }
        }
      } catch (err) {
        console.warn("pricing fetch failed", providerId, err);
      }
    }

    if (Object.keys(priceUpdates).length) {
      setPricing((prev) => ({ ...prev, ...priceUpdates }));
    }
    if (Object.keys(metaUpdates).length) {
      setTokenMeta((prev) => ({ ...prev, ...metaUpdates }));
    }
    if (Object.keys(nameUpdates).length) {
      setProviderNames((prev) => ({ ...prev, ...nameUpdates }));
    }
  }, [contract, signer, providers, tokenMeta, providerNames]);

  useEffect(() => {
    refreshPricing();
  }, [refreshPricing]);

  const refreshBatches = useCallback(async () => {
    if (!contract) return;
    const key = clinicKey(requesterClinicId);
    if (!key) {
      setBatches([]);
      return;
    }

    setLoadingBatches(true);
    setBatchError(null);

    try {
      const nextBatchId = await contract.nextBatchId();
      const latest = Number(nextBatchId ?? 0n);
      const rows: BatchRow[] = [];
      const nameUpdates: Record<string, string> = {};
      const metaUpdates: Record<string, TokenMeta> = {};

      for (let id = latest; id >= 1 && rows.length < 10; id--) {
        const batch = await contract.batches(id);
        if (!batch?.exists) continue;
        if ((batch.requesterClinicKey ?? "").toLowerCase() !== key) continue;

        const childIds: bigint[] = Array.isArray(batch.childIds) ? batch.childIds : [];
        const child: ChildRow[] = [];

        for (const childId of childIds) {
          const req = await contract.reqs(childId);
          const providerKey: string = (req.providerClinicKey ?? "").toLowerCase();
          const label = providerNames[providerKey] ?? providerKey;
          const statusIdx = Number(req.status ?? 0);
          const tokenAddr = checksum(req.token ?? ethers.ZeroAddress);
          const price = toBigIntSafe(req.price);

          child.push({
            id: childId.toString(),
            providerKey,
            providerLabel: label,
            status: STATUS_LABELS[statusIdx] ?? `#${statusIdx}`,
            price,
            token: tokenAddr,
            manifestHash: req.manifestHash ?? "",
          });

          if (!providerNames[providerKey]) {
            try {
              const clinic = await contract.clinics(providerKey);
              if (clinic?.registered) {
                nameUpdates[providerKey] = clinic.clinicId || providerKey;
              }
            } catch (err) {
              console.warn("clinic lookup failed", providerKey, err);
            }
          }

          const tKey = canonical(tokenAddr);
          if (!tokenMeta[tKey]) {
            try {
              const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, signer ?? contract.runner ?? undefined);
              let symbol = tokenAddr.slice(0, 6) + "…";
              let decimals = 18;
              try {
                symbol = await erc20.symbol();
              } catch { /* ignore */ }
              try {
                decimals = Number(await erc20.decimals());
              } catch { /* ignore */ }
              metaUpdates[tKey] = { symbol, decimals };
            } catch (err) {
              console.warn("token meta fetch failed", tokenAddr, err);
            }
          }
        }

        rows.push({
          batchId: id.toString(),
          mode: MODE_LABELS[Number(batch.mode ?? 0)] ?? String(batch.mode ?? 0),
          totalPrice: toBigIntSafe(batch.totalPrice),
          token: checksum(batch.token ?? ethers.ZeroAddress),
          child,
        });
      }

      setBatches(rows);
      if (Object.keys(nameUpdates).length) {
        setProviderNames((prev) => ({ ...prev, ...nameUpdates }));
      }
      if (Object.keys(metaUpdates).length) {
        setTokenMeta((prev) => ({ ...prev, ...metaUpdates }));
      }
    } catch (err: any) {
      console.error("batch refresh failed", err);
      setBatchError(err?.message || String(err));
    } finally {
      setLoadingBatches(false);
    }
  }, [contract, requesterClinicId, providerNames, signer, tokenMeta]);

  useEffect(() => {
    // トランザクション実行中はポーリングを停止して負荷を下げる
    if (pendingTx) return;

    refreshBatches();
    if (!contract) return;
    const interval = setInterval(() => {
      refreshBatches();
    }, 10000); // 5s -> 10s
    return () => clearInterval(interval);
  }, [contract, refreshBatches, pendingTx]);

  useEffect(() => {
    if (!signer || !address || trackedTokens.length === 0) return;
    // トランザクション実行中はポーリングを停止
    if (pendingTx) return;

    let cancelled = false;

    const refresh = async () => {
      const updates: Record<string, TokenBalance> = {};
      for (const token of trackedTokens) {
        try {
          const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
          const [allowanceBn, balanceBn] = await Promise.all([
            erc20.allowance(address, contractAddress),
            erc20.balanceOf(address),
          ]);
          updates[canonical(token)] = {
            allowance: BigInt(allowanceBn ?? 0n),
            balance: BigInt(balanceBn ?? 0n),
          };
        } catch (err) {
          console.warn("allowance fetch failed", token, err);
        }
      }
      if (!cancelled && Object.keys(updates).length) {
        setTokenBalances((prev) => ({ ...prev, ...updates }));
      }
    };

    refresh();
    const timer = setInterval(refresh, 15000); // 6s -> 15s
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [signer, address, trackedTokens, contractAddress, pendingTx]);

  const createBatch = async () => {
    if (!contract) return;
    if (!patientResolution.address) {
      setPendingTx("患者アドレスを解決できませんでした");
      return;
    }
    setPendingTx("申請送信中...");
    setLastReqId("");

    try {
      const tx = await contract.createAccessBatch(
        patientResolution.address,
        requesterClinicId.trim(),
        providers,
        mode
      );
      const receipt = await tx.wait();
      if (!receipt) {
        setPendingTx("トランザクションの確定を取得できませんでした");
        return;
      }

      let id: string | null = null;
      for (const log of receipt.logs ?? []) {
        try {
          const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
          if (parsed?.name === "AccessBatchCreated") {
            const childIds = parsed.args?.childIds as bigint[] | undefined;
            if (childIds && childIds.length) {
              id = childIds[0].toString();
              break;
            }
          }
        } catch { /* ignore */ }
      }

      if (!id) {
        for (const log of receipt.logs ?? []) {
          try {
            const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
            if (parsed?.name === "AccessRequested") {
              const val = parsed.args?.id as bigint | undefined;
              if (typeof val === "bigint") {
                id = val.toString();
                break;
              }
            }
          } catch { /* ignore */ }
        }
      }

      if (!id) {
        try {
          const n = await contract.nextReqId();
          id = (BigInt(n ?? 0n) - 1n).toString();
        } catch { /* ignore */ }
      }

      if (id) setLastReqId(id);
      setPendingTx("申請を送信しました");
      refreshBatches();
    } catch (e: any) {
      setPendingTx(e?.reason || e?.message || String(e));
    }
  };

  return (
    <div className="p-4 space-y-6">
      <div>
        <h2 className="text-xl font-bold">自院ダッシュボード（申請）</h2>
        {alertEvents.length > 0 && (
          <div className="mt-4 border-l-4 border-red-500 bg-red-50 p-3 text-sm space-y-1">
            <div>Worker でエラー/一部失敗が検出されています。</div>
            <div>
              最新: Request <span className="font-mono">#{alertEvents[0].requestId}</span> —
              {" "}
              {COPY_EVENT_STATUS_LABELS[alertEvents[0].status]}（{formatTimestamp(alertEvents[0].updatedAt)}）
            </div>
          </div>
        )}
        <div className="grid gap-3 mt-4">
          <input
            className="border p-2"
            placeholder="患者ウォレットアドレス or 患者ID"
            value={patient}
            onChange={(e) => setPatient(e.target.value)}
          />
          <div className="text-xs opacity-70">
            {patientResolution.status === "wallet" && "ウォレットアドレスを使用します。"}
            {patientResolution.status === "alias" && (
              <>
                患者IDから解決: <span className="font-mono">{patientResolution.address}</span>
              </>
            )}
            {patientResolution.status === "unresolved" && "エイリアスに登録された患者IDではありません。"}
            {patientResolution.status === "invalid" && "アドレスの形式が不正です。"}
            {!patientResolution.address && patientResolution.status === "none" && workerEndpoint && "患者IDを入力するとエイリアスから解決します。"}
            {!workerEndpoint && patientResolution.status !== "wallet" && "患者IDでの入力を使うには VITE_WORKER_API を設定してください。"}
            {aliasStatus && `エイリアス取得エラー: ${aliasStatus}`}
          </div>

          <input
            className="border p-2"
            placeholder="自院ClinicID（例 REQ-001）"
            value={requesterClinicId}
            onChange={(e) => setRequesterClinicId(e.target.value)}
          />

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                className="border p-2 flex-1"
                placeholder="提供院ClinicIDを追加（Enterで確定）"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const target = e.target as HTMLInputElement;
                    addProvider(target.value);
                    target.value = "";
                  }
                }}
              />
            </div>
            {providers.length > 0 && (
              <div className="flex flex-wrap gap-2 text-sm">
                {providers.map((id) => (
                  <span key={id} className="border rounded px-2 py-1 flex items-center gap-2">
                    {id}
                    <button
                      className="text-red-600"
                      onClick={() => removeProvider(id)}
                      title="この提供院を削除"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-4 items-center">
            <label className="flex items-center gap-1">
              <input type="radio" checked={mode === 0} onChange={() => setMode(0)} />
              READ
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={mode === 1} onChange={() => setMode(1)} />
              COPY
            </label>
          </div>

          <button
            className="border px-3 py-2 rounded disabled:opacity-50"
            onClick={createBatch}
            disabled={!canSubmit}
            title={!canSubmit ? "患者/自院ID/提供院IDを入力してください" : ""}
          >
            一括申請（エスクロー）
          </button>

          {lastReqId && (
            <div className="mt-2 text-sm">
              発行された申請ID: <span className="font-mono">{lastReqId}</span>
            </div>
          )}

          {pendingTx && <div className="text-sm opacity-80">{pendingTx}</div>}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-lg font-semibold">価格 & Allowance 概要</h3>
        {providers.length === 0 && <div className="text-sm opacity-70">提供院IDを追加すると価格が表示されます。</div>}
        {providers.length > 0 && (
          <table className="w-full text-sm border">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-2 py-1 text-left">Provider</th>
                <th className="px-2 py-1 text-left">READ価格</th>
                <th className="px-2 py-1 text-left">COPY価格</th>
                <th className="px-2 py-1 text-left">トークン</th>
                <th className="px-2 py-1 text-left">Allowance</th>
                <th className="px-2 py-1 text-left">残高</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((id) => {
                const price = pricing[id];
                if (!price?.set) {
                  return (
                    <tr key={id}>
                      <td className="border-t px-2 py-1">{id}</td>
                      <td className="border-t px-2 py-1" colSpan={5}>
                        価格が未設定です。
                      </td>
                    </tr>
                  );
                }
                const tokenKey = canonical(price.token);
                const meta = tokenMeta[tokenKey];
                const balances = tokenBalances[tokenKey];
                return (
                  <tr key={id}>
                    <td className="border-t px-2 py-1">{id}</td>
                    <td className="border-t px-2 py-1">{formatAmount(price.readPrice, price.token, tokenMeta)}</td>
                    <td className="border-t px-2 py-1">{formatAmount(price.copyPrice, price.token, tokenMeta)}</td>
                    <td className="border-t px-2 py-1 font-mono">{meta ? `${meta.symbol} (${checksum(price.token)})` : checksum(price.token)}</td>
                    <td className="border-t px-2 py-1">
                      {balances ? formatAmount(balances.allowance, price.token, tokenMeta) : "取得中"}
                    </td>
                    <td className="border-t px-2 py-1">
                      {balances ? formatAmount(balances.balance, price.token, tokenMeta) : "取得中"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Worker 進捗 / 通知</h3>
        {copyEventError && <div className="text-sm text-red-600">Worker API エラー: {copyEventError}</div>}
        {!copyEventError && recentCopyEvents.length === 0 && (
          <div className="text-sm opacity-70">最近のコピーイベントはありません。</div>
        )}
        {recentCopyEvents.map((event) => {
          const borderClass =
            event.status === "completed"
              ? "border-green-400"
              : event.status === "partial"
                ? "border-amber-400"
                : event.status === "error"
                  ? "border-red-500"
                  : "border-blue-400";
          const bgClass =
            event.status === "completed"
              ? "bg-green-50"
              : event.status === "partial"
                ? "bg-amber-50"
                : event.status === "error"
                  ? "bg-red-50"
                  : "bg-slate-50";
          return (
            <div
              key={`${event.requestId}-${event.updatedAt}`}
              className={`border-l-4 ${borderClass} ${bgClass} rounded p-3 space-y-2`}
            >
              <div className="flex flex-wrap gap-3 text-sm">
                <div>
                  Request ID: <span className="font-mono">#{event.requestId}</span>
                </div>
                {event.providerId && <div>Provider: {event.providerId}</div>}
                <div>
                  状態: <span className="font-semibold">{COPY_EVENT_STATUS_LABELS[event.status]}</span>
                </div>
                {event.total > 0 && (
                  <div>
                    成功: {event.success}/{event.total}
                  </div>
                )}
                {event.failed > 0 && <div className="text-red-600">失敗: {event.failed}</div>}
                <div>更新: {formatTimestamp(event.updatedAt)}</div>
              </div>

              {event.failures.length > 0 && (
                <div className="text-sm space-y-1">
                  <div>失敗した SOP (先頭のみ表示):</div>
                  <ul className="list-disc list-inside space-y-1 text-xs">
                    {event.failures.slice(0, 3).map((failure, idx) => (
                      <li key={`${failure.sop}-${idx}`} className="font-mono break-all">
                        {failure.sop}
                        {failure.message && <span className="ml-1 normal-case text-gray-600">— {failure.message}</span>}
                      </li>
                    ))}
                  </ul>
                  {event.failures.length > 3 && (
                    <div className="text-xs opacity-70">…ほか {event.failures.length - 3} 件</div>
                  )}
                </div>
              )}

              {event.errors.length > 0 && (
                <div className="text-sm text-red-700 space-y-1">
                  {event.errors.slice(-3).map((message, idx) => (
                    <div key={`${event.updatedAt}-err-${idx}`}>{message}</div>
                  ))}
                </div>
              )}

              {event.manifestHash && (
                <div className="text-xs font-mono break-all opacity-80">
                  Manifest: {event.manifestHash}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="space-y-3">
        <h3 className="text-lg font-semibold">進捗モニター（直近10件）</h3>
        {loadingBatches && <div className="text-sm">読み込み中…</div>}
        {batchError && <div className="text-sm text-red-600">{batchError}</div>}
        {!loadingBatches && batches.length === 0 && (
          <div className="text-sm opacity-70">対象バッチがまだありません。</div>
        )}
        {batches.map((batch) => (
          <div key={batch.batchId} className="border rounded p-3 space-y-2">
            <div className="flex flex-wrap gap-3 text-sm">
              <div>Batch ID: <span className="font-mono">{batch.batchId}</span></div>
              <div>Mode: {batch.mode}</div>
              <div>Total: {formatAmount(batch.totalPrice, batch.token, tokenMeta)}</div>
              <div>Token: <span className="font-mono">{checksum(batch.token)}</span></div>
            </div>
            <table className="w-full text-sm border">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-2 py-1 text-left">ReqID</th>
                  <th className="px-2 py-1 text-left">Provider</th>
                  <th className="px-2 py-1 text-left">状態</th>
                  <th className="px-2 py-1 text-left">価格</th>
                  <th className="px-2 py-1 text-left">Manifest Hash</th>
                </tr>
              </thead>
              <tbody>
                {batch.child.map((child) => (
                  <tr key={child.id}>
                    <td className="border-t px-2 py-1 font-mono">{child.id}</td>
                    <td className="border-t px-2 py-1">{providerNames[child.providerKey] ?? child.providerLabel}</td>
                    <td className="border-t px-2 py-1">{child.status}</td>
                    <td className="border-t px-2 py-1">{formatAmount(child.price, child.token, tokenMeta)}</td>
                    <td className="border-t px-2 py-1 font-mono break-all">{child.manifestHash || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
