import { readFile } from "node:fs/promises";
import axios, { AxiosInstance } from "axios";
import { Contract, JsonRpcProvider, Wallet, getAddress, keccak256, toUtf8Bytes } from "ethers";
import abi from "./abi/PatientAccess.json" with { type: "json" };
import {
  ProviderPushInstance,
  computeInstancesHash,
  buildPushMessage,
} from "./push-utils.js";

// ===== Types =====
type BasicAuth = { type: "basic"; username: string; password: string };

type HttpEndpoint = {
  baseUrl: string;
  auth?: BasicAuth;
};

type WorkerAuth =
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string };

type ProviderAgentConfig = {
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  clinicId: string;
  operatorPrivateKey: string;
  workerUrl: string;
  workerAuth?: WorkerAuth;
  provider: {
    qido: HttpEndpoint & { issuer?: string };
    wado: HttpEndpoint;
    rest?: HttpEndpoint;
  };
  aliasMap?: Record<string, string>;
  ttlSeconds?: number;
};

type CliArgs = {
  requestId: number;
  patientIdOverride?: string;
  workerUrlOverride?: string;
};

// ===== Helpers =====
function makeAxios(endpoint: HttpEndpoint): AxiosInstance {
  const authConfig =
    endpoint.auth?.type === "basic"
      ? { username: endpoint.auth.username, password: endpoint.auth.password }
      : undefined;
  return axios.create({
    baseURL: endpoint.baseUrl.replace(/\/+$/, ""),
    timeout: 30_000,
    auth: authConfig,
  });
}

function clinicKey(clinicId: string): string {
  return keccak256(toUtf8Bytes(clinicId));
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { requestId: NaN };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case "--requestId":
      case "-r":
        args.requestId = Number(next);
        i++;
        break;
      case "--patientId":
        args.patientIdOverride = next;
        i++;
        break;
      case "--workerUrl":
        args.workerUrlOverride = next;
        i++;
        break;
      default:
        if (!token.startsWith("-")) {
          if (!Number.isFinite(args.requestId)) {
            args.requestId = Number(token);
          }
        }
        break;
    }
  }

  if (!Number.isFinite(args.requestId)) {
    throw new Error("--requestId が指定されていません");
  }

  return args;
}

async function loadConfig(): Promise<ProviderAgentConfig> {
  const raw = await readFile(new URL("./provider-agent.config.json", import.meta.url), "utf-8");
  return JSON.parse(raw);
}

function makeOrthancClient(endpoint: HttpEndpoint) {
  return makeAxios(endpoint);
}

async function qidoFindInstances(endpoint: HttpEndpoint & { issuer?: string }, patientId: string) {
  const client = makeOrthancClient(endpoint);
  const params: Record<string, string> = {
    PatientID: patientId,
    includefield: "00080018,0020000D,0020000E",
    limit: "5000",
  };
  if (endpoint.issuer) {
    params.IssuerOfPatientID = endpoint.issuer;
  }
  const res = await client.get("/dicom-web/instances", {
    params,
    headers: { Accept: "application/json" },
  });
  const arr = Array.isArray(res.data) ? res.data : [];
  const out: { sop: string; study: string; series: string }[] = [];
  for (const entry of arr) {
    const sop = entry?.["00080018"]?.Value?.[0];
    const study = entry?.["0020000D"]?.Value?.[0];
    const series = entry?.["0020000E"]?.Value?.[0];
    if (sop && study && series) out.push({ sop, study, series });
  }
  return out;
}

async function wadoFetch(endpoint: HttpEndpoint, study: string, series: string, sop: string) {
  const client = makeOrthancClient(endpoint);
  const url = `/dicom-web/studies/${encodeURIComponent(study)}/series/${encodeURIComponent(series)}/instances/${encodeURIComponent(
    sop
  )}`;
  const res = await client.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    headers: { Accept: "application/dicom" },
  });
  return Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data as ArrayBuffer);
}

async function restFetch(endpoint: HttpEndpoint, sop: string) {
  const client = makeOrthancClient(endpoint);
  const lookup = await client.post(`/tools/lookup`, sop, {
    headers: { "Content-Type": "text/plain" },
  });
  const payload = Array.isArray(lookup.data) ? lookup.data : [];
  const first = payload.find((item) => typeof item === "string" || typeof item?.ID === "string");
  const instanceId = typeof first === "string" ? first : first?.ID;
  if (!instanceId) {
    throw new Error(`REST lookup failed for SOP ${sop}`);
  }
  const data = await client.get<ArrayBuffer>(`/instances/${encodeURIComponent(instanceId)}/file`, {
    responseType: "arraybuffer",
    headers: { Accept: "application/dicom" },
  });
  return Buffer.isBuffer(data.data) ? data.data : Buffer.from(data.data as ArrayBuffer);
}

async function fetchWithFallback(cfg: ProviderAgentConfig["provider"], sopInfo: { sop: string; study: string; series: string }) {
  try {
    return await wadoFetch(cfg.wado, sopInfo.study, sopInfo.series, sopInfo.sop);
  } catch (e) {
    if (!cfg.rest) throw e;
    return await restFetch(cfg.rest, sopInfo.sop);
  }
}

function resolvePatientId(
  patientAddress: string,
  aliasMap: Record<string, string> | undefined,
  override?: string
): string {
  if (override && override.trim()) {
    return override.trim();
  }
  if (!aliasMap) return "";
  const canonical = getAddress(patientAddress).toLowerCase();
  for (const [addr, pid] of Object.entries(aliasMap)) {
    try {
      if (getAddress(addr).toLowerCase() === canonical) {
        return pid;
      }
    } catch {
      continue;
    }
  }
  return "";
}

async function performWithRetry<T>(fn: () => Promise<T>, label: string, attempts = 3, backoffMs = 1000): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const message = (err as any)?.message || String(err);
      console.warn(`${label} attempt ${attempt}/${attempts} failed: ${message}`);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr;
}

// ===== Main =====
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();

  const contractAddress = getAddress(config.contractAddress);
  const rpcProvider = new JsonRpcProvider(config.rpcUrl, config.chainId);
  const wallet = new Wallet(config.operatorPrivateKey, rpcProvider);
  const contract = new Contract(contractAddress, (abi as any).abi, rpcProvider);

  const requestId = args.requestId;
  const accessRequest = await contract.reqs(requestId);
  if (!accessRequest || Number(accessRequest.id ?? 0) === 0) {
    throw new Error(`requestId ${requestId} が見つかりません`);
  }
  const status = Number(accessRequest.status ?? 0);
  if (status < 1) {
    throw new Error(`requestId ${requestId} は PATIENT_APPROVED ではありません`);
  }

  const providerKey = String(accessRequest.providerClinicKey ?? "").toLowerCase();
  const expectedKey = clinicKey(config.clinicId).toLowerCase();
  if (providerKey !== expectedKey) {
    throw new Error(
      `requestId ${requestId} の providerClinicKey が config.clinicId (${config.clinicId}) と一致しません`
    );
  }

  const patientAddress = String(accessRequest.patient ?? "");
  if (!patientAddress) {
    throw new Error("access request に patient が含まれていません");
  }

  const patientId = resolvePatientId(patientAddress, config.aliasMap, args.patientIdOverride);
  if (!patientId) {
    throw new Error("患者IDを特定できませんでした (--patientId で明示してください)");
  }

  console.log(`[push-agent] requestId=${requestId}`);
  console.log(`[push-agent] patientId=${patientId}`);

  const instances = await qidoFindInstances(config.provider.qido, patientId);
  console.log(`[push-agent] QIDO found ${instances.length} instances`);

  const pushInstances: ProviderPushInstance[] = [];
  let successCount = 0;
  let failureCount = 0;

  for (const entry of instances) {
    let base64 = "";
    try {
      const buffer = await performWithRetry(
        () => fetchWithFallback(config.provider, entry),
        `fetch ${entry.sop}`
      );
      base64 = Buffer.from(buffer).toString("base64");
      successCount += 1;
    } catch (e: any) {
      const message = e?.message || String(e);
      console.warn(`[push-agent] fetch failed for ${entry.sop}: ${message}`);
      failureCount += 1;
    }
    pushInstances.push({
      sop: entry.sop,
      study: entry.study,
      series: entry.series,
      data: base64,
    });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + (config.ttlSeconds ?? 300);
  const payloadHash = computeInstancesHash(pushInstances);
  const message = buildPushMessage(config.clinicId, requestId, expiresAt, payloadHash);
  const signature = await wallet.signMessage(message);

  const workerUrl = args.workerUrlOverride ?? config.workerUrl;
  const endpoint = new URL("/provider-push", workerUrl).toString();

  const payload = {
    clinicId: config.clinicId,
    requestId,
    expiresAt,
    instances: pushInstances,
    signature,
  };

  console.log(`[push-agent] uploading to ${endpoint}`);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const requestConfig: any = {
    url: endpoint,
    method: "POST",
    data: payload,
    timeout: 60_000,
    headers,
  };

  if (config.workerAuth?.type === "bearer") {
    headers.Authorization = `Bearer ${config.workerAuth.token}`;
  } else if (config.workerAuth?.type === "basic") {
    requestConfig.auth = {
      username: config.workerAuth.username,
      password: config.workerAuth.password,
    };
  }

  const res = await axios.request(requestConfig);

  console.log(`[push-agent] worker response:`, res.data);
  console.log(`[push-agent] success=${successCount}, failed=${failureCount}`);
}

main().catch((err) => {
  console.error(`[push-agent] error:`, err?.message || err);
  process.exit(1);
});
