import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { useContract } from "../hooks/usePatientAccess";
import { clinicKey, checksum } from "../lib/clinic";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

function isAddress(value: string): boolean {
  try {
    ethers.getAddress(value);
    return true;
  } catch {
    return false;
  }
}

type Props = {
  contractAddress: string;
};

export default function ProviderSettings({ contractAddress }: Props) {
  const { contract, signer, address } = useContract(contractAddress);

  const [providerId, setProviderId] = useState("PROV-001");
  const [token, setToken] = useState("");
  const [readPrice, setReadPrice] = useState("0");
  const [copyPrice, setCopyPrice] = useState("0");
  const [decimals, setDecimals] = useState<number>(18);
  const [symbol, setSymbol] = useState<string>("TKN");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isAuthorised, setIsAuthorised] = useState(false);

  const providerKey = useMemo(() => clinicKey(providerId), [providerId]);

  const fetchClinicAuth = useCallback(async () => {
    if (!contract || !address || !providerKey) {
      setIsAuthorised(false);
      return;
    }

    try {
      const clinic = await contract.clinics(providerKey);
      const caller = address.toLowerCase();
      const payout = (clinic?.payout ?? ethers.ZeroAddress).toLowerCase();
      const operator = (clinic?.operator ?? ethers.ZeroAddress).toLowerCase();
      setIsAuthorised(caller === payout || caller === operator);
    } catch (err) {
      console.warn("clinic lookup failed", err);
      setIsAuthorised(false);
    }
  }, [contract, address, providerKey]);

  const loadPrice = useCallback(async () => {
    if (!contract) return;
    if (!providerKey) {
      setStatus("Clinic ID を入力してください");
      setError(null);
      return;
    }

    setStatus("読み込み中…");
    setError(null);
    setTxHash(null);

    try {
      const price = await contract.prices(providerKey);
      if (!price?.set) {
        setToken("");
        setReadPrice("0");
        setCopyPrice("0");
        setSymbol("TKN");
        setDecimals(18);
        setStatus("未設定です");
        return;
      }

      const tokenAddress = checksum(price.token ?? ethers.ZeroAddress);
      setToken(tokenAddress);

      let sym = tokenAddress.slice(0, 6) + "…";
      let dec = 18;

      if (isAddress(tokenAddress) && signer) {
        const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
        try {
          sym = await erc20.symbol();
        } catch {
          // ignore
        }
        try {
          dec = Number(await erc20.decimals());
        } catch {
          // ignore
        }
      }

      setDecimals(dec);
      setSymbol(sym);
      setReadPrice(ethers.formatUnits(price.readPrice ?? 0n, dec));
      setCopyPrice(ethers.formatUnits(price.copyPrice ?? 0n, dec));
      setStatus("現在値を取得しました");
    } catch (err: any) {
      console.error("price load failed", err);
      setError(err?.message || String(err));
      setStatus(null);
    }
  }, [contract, providerKey, signer]);

  const refreshTokenMeta = useCallback(
    async (addressInput: string) => {
      if (!signer || !isAddress(addressInput)) {
        setSymbol("TKN");
        setDecimals(18);
        return;
      }
      try {
        const erc20 = new ethers.Contract(addressInput, ERC20_ABI, signer);
        let sym = addressInput.slice(0, 6) + "…";
        let dec = 18;
        try {
          sym = await erc20.symbol();
        } catch { /* ignore */ }
        try {
          dec = Number(await erc20.decimals());
        } catch { /* ignore */ }
        setSymbol(sym);
        setDecimals(dec);
      } catch (err) {
        console.warn("erc20 meta fetch failed", err);
        setSymbol("TKN");
        setDecimals(18);
      }
    },
    [signer]
  );

  useEffect(() => {
    fetchClinicAuth();
  }, [fetchClinicAuth]);

  useEffect(() => {
    loadPrice();
  }, [loadPrice]);

  useEffect(() => {
    if (token) refreshTokenMeta(token);
  }, [token, refreshTokenMeta]);

  const handleTokenChange = (value: string) => {
    setToken(value);
    if (value.trim()) {
      refreshTokenMeta(value.trim());
    } else {
      setSymbol("TKN");
      setDecimals(18);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!contract || !signer) return;
    if (!providerId.trim()) {
      setError("Provider Clinic ID を入力してください");
      return;
    }
    if (!isAddress(token)) {
      setError("正しいトークンアドレスを入力してください");
      return;
    }

    try {
      setLoading(true);
      setStatus("トランザクション送信中…");
      setError(null);
      setTxHash(null);

      const dec = Number.isFinite(decimals) ? decimals : 18;
      const readValue = ethers.parseUnits(readPrice || "0", dec);
      const copyValue = ethers.parseUnits(copyPrice || "0", dec);

      const tx = await contract.setPrice(providerId.trim(), token.trim(), readValue, copyValue);
      setTxHash(tx.hash);
      const receipt = await tx.wait();
      setStatus(`設定を更新しました (block ${receipt.blockNumber})`);
      await loadPrice();
    } catch (err: any) {
      console.error("setPrice failed", err);
      const message = err?.error?.message || err?.message || String(err);
      setError(message);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border rounded p-4 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">プロバイダー価格設定</h2>
        <p className="text-sm opacity-70">`setPrice` を呼び出して READ/COPY 料金を更新します。</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block text-sm">
          <span className="font-medium">Provider Clinic ID</span>
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            placeholder="PROV-001"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">支払いトークンアドレス</span>
            <input
              className="mt-1 w-full rounded border px-3 py-2 font-mono"
              value={token}
              onChange={(e) => handleTokenChange(e.target.value)}
              placeholder="0x..."
            />
          </label>

          <div className="text-sm border rounded px-3 py-2 bg-slate-50">
            <div>シンボル: <span className="font-mono">{symbol}</span></div>
            <div>Decimals: {decimals}</div>
            {txHash && (
              <div className="mt-1 truncate text-xs opacity-70">Tx: {txHash}</div>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">READ 価格 ({symbol})</span>
            <input
              className="mt-1 w-full rounded border px-3 py-2 text-right"
              type="number"
              min="0"
              step="any"
              value={readPrice}
              onChange={(e) => setReadPrice(e.target.value)}
            />
          </label>

          <label className="block text-sm">
            <span className="font-medium">COPY 価格 ({symbol})</span>
            <input
              className="mt-1 w-full rounded border px-3 py-2 text-right"
              type="number"
              min="0"
              step="any"
              value={copyPrice}
              onChange={(e) => setCopyPrice(e.target.value)}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button
            type="submit"
            disabled={!contract || !isAuthorised || loading}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:bg-slate-400"
          >
            {loading ? "更新中…" : "価格を更新"}
          </button>

          <button
            type="button"
            className="rounded border px-3 py-2"
            onClick={() => loadPrice()}
          >
            再取得
          </button>

          {!contract && <span className="text-red-600">コントラクトに接続できません。</span>}
          {contract && !isAuthorised && (
            <span className="text-orange-600">このウォレットは該当クリニックの operator / payout ではありません。</span>
          )}
          {status && <span className="text-green-700">{status}</span>}
          {error && <span className="text-red-600">{error}</span>}
        </div>
      </form>
    </div>
  );
}
