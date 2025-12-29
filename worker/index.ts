// worker/index.ts
import { readFile, writeFile, appendFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import axios, { AxiosInstance } from "axios";
import { JsonRpcProvider, Contract, keccak256, toUtf8Bytes, getAddress, verifyMessage } from "ethers";
import abi from "./abi/PatientAccess.json" with { type: "json" };
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProviderPushEnvelope,
  ProviderPushInstance,
  computeInstancesHash,
  buildPushMessage,
} from "./push-utils.js";
import { JwtAuth, requireAuth } from "./auth.js";
import type { AuthConfig, Principal } from "./auth.js";
import { SignerClient } from "./signer-client.js";
import type { SignerConfig, MarkFulfilledResult } from "./signer-client.js";
import { AlertService } from "./alert-service.js";
import type { AlertConfig } from "./alert-service.js";
import { CleanupService } from "./cleanup-service.js";
import { AuditLogger } from "./audit-logger.js";
import type { AuditCfg, AuditLogEntry } from "./audit-logger.js";
import { ClinicStore } from "./clinic-store.js";
import type { DicomNodeConfig } from "./clinic-store.js";

// ========= 型定義 =========
type BasicAuth = { type: "basic"; username: string; password: string };
type HttpEndpoint = { baseUrl: string; auth?: BasicAuth };

type ClinicCfg = {
  role: "provider" | "requester";
  operatorAddress?: string;
  priceToken?: string;
};

type ProviderCfg = {
  qido: HttpEndpoint & { issuer?: string };
  wado: HttpEndpoint;
  rest?: HttpEndpoint;
};

type RequesterCfg = {
  orthanc: HttpEndpoint;
};

type AliasResolver =
  | { type: "passthrough" }
  | { type: "map"; map: Record<string, string> };

type CopyCfg = {
  mode?: "dryRun" | "orthanc" | "providerPush";
  batchSize?: number;
  maxRetries?: number;
  backoffMs?: number;
  fulfillmentPollMs?: number;
  fulfillmentMaxAttempts?: number;
};

type ApiCfg = {
  host?: string;
  port?: number;
  corsOrigin?: string;
  ssl?: {
    cert: string;
    key: string;
  };
};

type Config = {
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  clinics: Record<string, ClinicCfg>;
  providers?: Record<string, ProviderCfg>;
  requester?: RequesterCfg;
  aliasResolver?: AliasResolver;
  copy?: CopyCfg;
  logLevel?: "info" | "debug";
  api?: ApiCfg;
  audit?: AuditCfg;
  auth?: AuthConfig;

  signers?: Record<string, SignerConfig>;
  alerts?: AlertConfig;
};

type PendingPushEntry = {
  requestId: number;
  providerId: string;
  patientAddress: string;
  patientId: string;
};

type ProviderPushResult = {
  status: number;
  body?: any;
  error?: string;
};

// ========= ユーティリティ =========
async function loadConfig(): Promise<Config> {
  const json = await readFile(new URL("./config.json", import.meta.url), "utf-8");
  return JSON.parse(json);
}

function makeAxios(ep: HttpEndpoint): AxiosInstance {
  const auth =
    ep.auth?.type === "basic" ? { username: ep.auth.username, password: ep.auth.password } : undefined;
  return axios.create({
    baseURL: ep.baseUrl.replace(/\/+$/, ""),
    auth,
    timeout: 30_000,
  });
}

function log(...args: any[]) {
  console.log(...args);
}
function warn(...args: any[]) {
  console.warn(...args);
}
function err(...args: any[]) {
  console.error(...args);
}

function formatAxiosError(e: any): string {
  if (!e) return "unknown error";
  if (e.response) {
    const { status, statusText, headers, data } = e.response;
    return `HTTP ${status} ${statusText} body=${JSON.stringify(data)} headers=${JSON.stringify(headers)}`;
  }
  if (e.request) {
    return "no response (network error)";
  }
  return e.message || String(e);
}

function clinicKey(clinicId: string): string {
  return keccak256(toUtf8Bytes(clinicId));
}

function sanitiseParams(params: URLSearchParams, opts?: { exclude?: string[] }): Record<string, string> | undefined {
  const entries = Array.from(params.entries()).filter(([key]) => !opts?.exclude?.includes(key));
  if (!entries.length) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    out[key] = /pass|token|secret/i.test(key) ? "***" : value;
  }
  return out;
}

async function getRequestAndProviderId(contract: Contract, id: number, cfg: Config, clinicStore: ClinicStore) {
  const r = await contract.reqs(id);
  const providerKey: string = r.providerClinicKey;

  // Try finding in dynamic store first (by hash)
  const dynamicProvider = clinicStore.findByHash(providerKey);
  if (dynamicProvider) {
    return { req: r, providerId: dynamicProvider.clinicId };
  }

  // Fallback to static config
  let providerId = Object.keys(cfg.providers ?? {}).find(
    (pid) => clinicKey(pid).toLowerCase() === providerKey.toLowerCase()
  );
  if (!providerId) {
    providerId = Object.keys(cfg.clinics ?? {}).find(
      (cid) => cfg.clinics[cid]?.role === "provider" && clinicKey(cid).toLowerCase() === providerKey.toLowerCase()
    );
  }
  return { req: r, providerId };
}

// ========= Alias Store =========
class AliasStore {
  private map: Record<string, string> = {};
  private constructor(private readonly fileUrl: URL, initial: Record<string, string>) {
    this.map = {};
    for (const [addr, value] of Object.entries(initial || {})) {
      const key = this.canonical(addr);
      if (key) this.map[key] = String(value);
    }
  }

  static async init(initial: Record<string, string>): Promise<AliasStore> {
    const fileUrl = new URL("./alias-map.json", import.meta.url);
    let persisted: Record<string, string> = {};
    try {
      const raw = await readFile(fileUrl, "utf-8");
      persisted = JSON.parse(raw);
    } catch (e: any) {
      if (e?.code !== "ENOENT") warn("alias-map.json 読み込みに失敗しました", e);
    }
    const merged = { ...initial, ...persisted };
    const store = new AliasStore(fileUrl, merged);
    await store.persist();
    return store;
  }

  list(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.map)) {
      out[this.checksum(key)] = value;
    }
    return out;
  }

  lookup(addr: string): string | undefined {
    const key = this.canonical(addr);
    if (!key) return undefined;
    return this.map[key];
  }

  async set(addr: string, value: string) {
    const key = this.canonical(addr);
    if (!key) throw new Error("invalid address");
    this.map[key] = value;
    await this.persist();
  }

  async remove(addr: string) {
    const key = this.canonical(addr);
    if (!key) throw new Error("invalid address");
    delete this.map[key];
    await this.persist();
  }

  private canonical(addr: string): string | null {
    if (typeof addr !== "string") return null;
    const trimmed = addr.trim();
    if (!trimmed) return null;
    try {
      return getAddress(trimmed).toLowerCase();
    } catch {
      return null;
    }
  }

  private checksum(addr: string): string {
    try {
      return getAddress(addr);
    } catch {
      return addr;
    }
  }

  private async persist() {
    const serialisable: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.map)) {
      serialisable[this.checksum(key)] = value;
    }
    await writeFile(this.fileUrl, JSON.stringify(serialisable, null, 2) + "\n", "utf-8");
  }
}

type CopyEventStatus = "pending" | "copying" | "completed" | "partial" | "error";

type CopyEventFailure = {
  sop: string;
  message: string;
};

type CopyEvent = {
  requestId: number;
  providerId?: string;
  patientAddress: string;
  patientId: string;
  total: number;
  success: number;
  failed: number;
  status: CopyEventStatus;
  errors: string[];
  failures: CopyEventFailure[];
  manifestHash?: string;
  startedAt: string;
  updatedAt: string;
};

type CopyEventUpdate = {
  total?: number;
  success?: number;
  failed?: number;
  status?: CopyEventStatus;
  manifestHash?: string;
  error?: string;
};

class CopyEventStore {
  private readonly events = new Map<number, CopyEvent>();
  private readonly order: number[] = [];
  private readonly alertService?: AlertService;
  private readonly limit: number;

  constructor(limit = 50, alertService?: AlertService) {
    this.limit = limit;
    this.alertService = alertService;
  }

  start(payload: { requestId: number; providerId?: string; patientAddress: string; patientId: string }): CopyEvent {
    const now = new Date().toISOString();
    const existingIdx = this.order.indexOf(payload.requestId);
    if (existingIdx >= 0) {
      this.order.splice(existingIdx, 1);
    }
    const entry: CopyEvent = {
      requestId: payload.requestId,
      providerId: payload.providerId,
      patientAddress: payload.patientAddress,
      patientId: payload.patientId,
      total: 0,
      success: 0,
      failed: 0,
      status: "pending",
      errors: [],
      failures: [],
      startedAt: now,
      updatedAt: now,
    };
    this.events.set(payload.requestId, entry);
    this.order.push(payload.requestId);
    this.trim();
    return entry;
  }

  update(id: number, patch: CopyEventUpdate): CopyEvent | undefined {
    const entry = this.events.get(id);
    if (!entry) return undefined;
    if (typeof patch.total === "number") entry.total = patch.total;
    if (typeof patch.success === "number") entry.success = patch.success;
    if (typeof patch.failed === "number") entry.failed = patch.failed;
    if (patch.status) entry.status = patch.status;
    if (patch.manifestHash !== undefined) entry.manifestHash = patch.manifestHash;
    if (patch.error) {
      entry.errors = [...entry.errors, patch.error].slice(-5);
    }
    entry.updatedAt = new Date().toISOString();
    return entry;
  }

  recordFailure(id: number, failure: CopyEventFailure) {
    const entry = this.events.get(id);
    if (!entry) return;
    entry.failures = [...entry.failures, failure].slice(-20);
    entry.updatedAt = new Date().toISOString();
  }

  fail(id: number, message: string) {
    const entry = this.events.get(id);
    if (!entry) return;
    entry.status = "error";
    entry.errors = [...entry.errors, message].slice(-5);
    entry.updatedAt = new Date().toISOString();

    if (this.alertService) {
      this.alertService.send(`Copy failed for Request #${id}: ${message}`, {
        requestId: id,
        patientId: entry.patientId,
        errors: entry.errors,
      });
    }
  }

  list(): CopyEvent[] {
    return Array.from(this.events.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((event) => ({
        ...event,
        errors: [...event.errors],
        failures: event.failures.map((f) => ({ ...f })),
      }));
  }

  private trim() {
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.events.delete(oldest);
      }
    }
  }
}

// ========= HTTP API (Alias 管理) =========
async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`invalid JSON: ${e?.message || e}`);
  }
}

type GatewayDeps = {
  api?: ApiCfg;
  contract: Contract;
  requesterAxios?: AxiosInstance | null;
  clinics: Config["clinics"];
  audit?: AuditLogger | null;
  copyEvents: CopyEventStore;
  requesterAuth?: BasicAuth | null;
  handleProviderPush?: (payload: ProviderPushEnvelope) => Promise<ProviderPushResult>;
  auth?: JwtAuth | null;
  clinicStore: ClinicStore;
};

function startApiServer(store: AliasStore, deps: GatewayDeps) {
  const host = deps.api?.host ?? "127.0.0.1";
  const port = deps.api?.port ?? 8787;
  const rawCors = (deps.api?.corsOrigin ?? "*").split(",").map((s) => s.trim()).filter(Boolean);
  const allowAllCors = rawCors.includes("*");
  const corsAllowList = allowAllCors ? [] : rawCors;
  const requester = deps.requesterAxios ?? null;
  const audit = deps.audit ?? null;
  const requesterAuth = deps.requesterAuth ?? null;
  const auth = deps.auth ?? null;

  function getClientIp(req: IncomingMessage): string | undefined {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",").map((p) => p.trim())[0];
    }
    return req.socket?.remoteAddress ?? undefined;
  }

  function applyCors(res: ServerResponse, originHeader?: string) {
    if (allowAllCors) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return;
    }
    if (originHeader && corsAllowList.includes(originHeader)) {
      res.setHeader("Access-Control-Allow-Origin", originHeader);
      res.setHeader("Vary", "Origin");
      return;
    }
    if (corsAllowList.length > 0) {
      res.setHeader("Access-Control-Allow-Origin", corsAllowList[0]);
      res.setHeader("Vary", "Origin");
    }
  }

  async function resolveAccessRequest(requestId: number) {
    const reqData = await deps.contract.reqs(requestId);
    if (!reqData || Number(reqData.id ?? 0) === 0) {
      return {
        ok: false as const,
        status: 404,
        message: "request not found",
      };
    }

    const status = Number(reqData.status ?? 0);
    if (status < 1) {
      return {
        ok: false as const,
        status: 403,
        message: "request is not approved",
      };
    }

    const requesterKey = (reqData.requesterClinicKey ?? "").toLowerCase();
    const allowedRequester = Object.entries(deps.clinics ?? {}).some(([clinicId, info]) => {
      if (!info || info.role !== "requester") return false;
      return clinicKey(clinicId).toLowerCase() === requesterKey;
    });
    if (!allowedRequester) {
      return {
        ok: false as const,
        status: 403,
        message: "requester clinic is not managed by this worker",
      };
    }

    const patientAddress = String(reqData.patient ?? "");
    const patientId = resolvePatientId(store, patientAddress);

    return {
      ok: true as const,
      reqData,
      patientAddress,
      patientId,
    };
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!req.url || !req.method) {
        res.statusCode = 400;
        res.end("Bad Request");
        return;
      }
      const url = new URL(req.url, `http://${host}:${port}`);

      applyCors(res, req.headers.origin as string | undefined);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept");
      res.setHeader("Access-Control-Allow-Methods", "GET,PUT,DELETE,OPTIONS");

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        res.statusCode = 200;
        res.end("OK");
        return;
      }

      if (req.method === "GET" && url.pathname === "/aliases") {
        const authResult = await requireAuth(req, res, auth, ["worker.admin"]);
        if (!authResult.ok) return;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ aliases: store.list() }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/copy-events") {
        const authResult = await requireAuth(req, res, auth, ["worker.read"]);
        if (!authResult.ok) return;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ events: deps.copyEvents.list() }));
        return;
      }

      if (req.method === "PUT" && url.pathname === "/aliases") {
        const authResult = await requireAuth(req, res, auth, ["worker.admin"]);
        if (!authResult.ok) return;
        const body = await readJsonBody(req);
        await store.set(body.address, String(body.patientId ?? ""));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ aliases: store.list() }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/audit-logs") {
        const authResult = await requireAuth(req, res, auth, ["worker.admin"]);
        if (!authResult.ok) return;
        const limit = Number(url.searchParams.get("limit") || "100");
        const logs = audit ? await audit.read(limit) : [];
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ logs }));
        return;
      }

      // Clinic Config API
      if (req.method === "GET" && url.pathname === "/clinics/config") {
        const authResult = await requireAuth(req, res, auth, ["worker.admin"]);
        if (!authResult.ok) return;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ configs: deps.clinicStore.list() }));
        return;
      }

      if (req.method === "PUT" && url.pathname === "/clinics/config") {
        const authResult = await requireAuth(req, res, auth, ["worker.admin"]);
        if (!authResult.ok) return;
        const body = await readJsonBody(req);
        // Basic validation
        if (!body.clinicId || !body.qido || !body.wado) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "missing required fields (clinicId, qido, wado)" }));
          return;
        }

        // Access Control: Admin can edit anyone. Others can only edit their own clinicId.
        const isAdmin = authResult.principal?.roles.includes("worker.admin");
        if (!isAdmin && authResult.principal?.clinicId !== body.clinicId) {
          // If auth is disabled (principal is minimal or null checking might be needed if requireAuth returns ok without auth),
          // but requireAuth ensures we have a principal if auth is enabled.
          // If auth is disabled globally, requireAuth returns ok=true immediately.
          // Here we assume if 'auth' object exists, we enforce checks.
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "forbidden: you can only edit your own clinic" }));
          return;
        }

        await deps.clinicStore.set(body);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ configs: deps.clinicStore.list() }));
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/clinics/config/")) {
        const authResult = await requireAuth(req, res, auth, ["worker.admin"]);
        if (!authResult.ok) return;
        const target = decodeURIComponent(url.pathname.replace("/clinics/config/", ""));

        // Access Control
        const isAdmin = authResult.principal?.roles.includes("worker.admin");
        if (!isAdmin && authResult.principal?.clinicId !== target) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "forbidden: you can only delete your own clinic" }));
          return;
        }

        await deps.clinicStore.remove(target);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ configs: deps.clinicStore.list() }));
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/aliases/")) {
        const authResult = await requireAuth(req, res, auth, ["worker.admin"]);
        if (!authResult.ok) return;
        const target = decodeURIComponent(url.pathname.replace("/aliases/", ""));
        await store.remove(target);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ aliases: store.list() }));
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/dicom-web-config")) {
        const authResult = await requireAuth(req, res, auth, ["requester.viewer"]);
        if (!authResult.ok) return;
        let requestIdParam = url.searchParams.get("requestId");
        const configMatch = url.pathname.match(/^\/dicom-web-config\/(\d+)(?:\.json)?$/);
        if (!requestIdParam && configMatch) {
          requestIdParam = configMatch[1];
        }

        if (!requestIdParam) {
          res.statusCode = 400;
          res.end("requestId is required");
          return;
        }

        const requestId = Number(requestIdParam);
        if (!Number.isFinite(requestId)) {
          res.statusCode = 400;
          res.end("requestId must be numeric");
          return;
        }

        const ctx = await resolveAccessRequest(requestId);
        if (!ctx.ok) {
          res.statusCode = ctx.status;
          res.end(ctx.message);
          warn(`gateway: config ${requestId} blocked (${ctx.message})`);
          await audit?.log({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: url.pathname,
            forwardPath: "/dicom-web-config",
            requestId,
            patientAddress: "",
            patientId: "",
            query: sanitiseParams(url.searchParams),
            status: ctx.status,
            error: ctx.message,
            subject: authResult.principal?.subject,
            roles: authResult.principal?.roles,
            clientIp: getClientIp(req),
          });
          return;
        }

        const clientIp = getClientIp(req);
        const origin = `${url.protocol}//${url.host}`;
        const dicomRoot = `${origin}/secure/${requestId}/dicom-web`;
        const requestOptions =
          requesterAuth?.type === "basic"
            ? {
              auth: {
                username: requesterAuth.username,
                password: requesterAuth.password,
              },
            }
            : undefined;

        const payload: any = {
          servers: {
            dicomWeb: [
              {
                name: "Requester Orthanc",
                wadoUriRoot: dicomRoot,
                qidoRoot: dicomRoot,
                wadoRoot: dicomRoot,
                qidoSupportsIncludeField: true,
                supportsReject: true,
                supportsFuzzyMatching: true,
                supportsWildcard: true,
                enableStudyLazyLoad: true,
                imageRendering: "wadors",
                thumbnailRendering: "wadors",
              },
            ],
          },
        };

        if (requestOptions) {
          payload.servers.dicomWeb[0].requestOptions = requestOptions;
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
        await audit?.log({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: url.pathname,
          forwardPath: "/dicom-web-config",
          requestId,
          patientAddress: String(ctx.patientAddress ?? ""),
          patientId: String(ctx.patientId ?? ""),
          query: sanitiseParams(url.searchParams),
          status: 200,
          subject: authResult.principal?.subject,
          roles: authResult.principal?.roles,
          clientIp,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/provider-push") {
        const authResult = await requireAuth(req, res, auth, ["provider.push"]);
        if (!authResult.ok) return;
        if (!deps.handleProviderPush) {
          res.statusCode = 501;
          res.end("provider push handler not configured");
          return;
        }

        const body = (await readJsonBody(req)) as ProviderPushEnvelope;
        const result = await deps.handleProviderPush(body);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        if (result.error) {
          res.end(JSON.stringify({ error: result.error }));
        } else if (result.body !== undefined) {
          res.end(JSON.stringify(result.body));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
        if (result.status >= 400) {
          await audit?.log({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: url.pathname,
            forwardPath: "/provider-push",
            requestId: Number((body?.requestId ?? 0) || 0),
            patientAddress: "0x",
            patientId: "",
            query: undefined,
            status: result.status,
            error: result.error,
            subject: authResult.principal?.subject,
            roles: authResult.principal?.roles,
            clientIp: getClientIp(req),
          });
        }
        return;
      }

      if (requester && req.method === "GET" && url.pathname.startsWith("/secure/")) {
        const authResult = await requireAuth(req, res, auth, ["requester.viewer"]);
        if (!authResult.ok) return;
        const clientIp = getClientIp(req);
        let requestIdParam = url.searchParams.get("requestId");
        let forwardPathRaw = url.pathname.replace(/^\/secure/, "");

        const pathMatch = forwardPathRaw.match(/^\/(\d+)(\/.*)?$/);
        if (!requestIdParam && pathMatch) {
          requestIdParam = pathMatch[1];
          forwardPathRaw = pathMatch[2] ?? "/";
        }

        if (!requestIdParam) {
          res.statusCode = 400;
          res.end("requestId is required");
          return;
        }

        const requestId = Number(requestIdParam);
        if (!Number.isFinite(requestId)) {
          res.statusCode = 400;
          res.end("requestId must be numeric");
          return;
        }

        const ctx = await resolveAccessRequest(requestId);
        if (!ctx.ok) {
          res.statusCode = ctx.status;
          res.end(ctx.message);
          warn(`gateway: request ${requestId} blocked (${ctx.message})`);
          await audit?.log({
            timestamp: new Date().toISOString(),
            method: req.method,
            path: url.pathname,
            forwardPath: url.pathname,
            requestId,
            patientAddress: "",
            patientId: "",
            query: sanitiseParams(new URLSearchParams(url.searchParams), { exclude: ["requestId"] }),
            status: ctx.status,
            error: ctx.message,
            subject: authResult.principal?.subject,
            roles: authResult.principal?.roles,
            clientIp,
          });
          return;
        }

        const { patientAddress, patientId } = ctx;

        let forwardPath = forwardPathRaw;
        if (!forwardPath || forwardPath === "/") {
          forwardPath = "/";
        } else if (!forwardPath.startsWith("/")) {
          forwardPath = `/${forwardPath}`;
        }

        const snapshot = new URLSearchParams(url.searchParams);
        const auditQuery = sanitiseParams(snapshot, { exclude: ["requestId"] });
        const search = new URLSearchParams(snapshot);
        search.delete("requestId");
        const forwardUrl = `${forwardPath}${search.toString() ? `?${search.toString()}` : ""}`;

        const auditCommon: Omit<AuditLogEntry, "status"> = {
          timestamp: new Date().toISOString(),
          method: req.method,
          path: url.pathname,
          forwardPath,
          requestId,
          patientAddress,
          patientId,
          query: auditQuery,
          subject: authResult.principal?.subject,
          roles: authResult.principal?.roles,
          clientIp,
        };

        const accept = req.headers["accept"] as string | undefined;
        const wantsBinary = accept ? /application\/dicom|image\//i.test(accept) : forwardPath.includes("/instances/");
        const responseType: any = wantsBinary ? "arraybuffer" : "json";

        try {
          const axiosRes = await requester.request({
            method: "GET",
            url: forwardUrl,
            responseType,
            headers: {
              Accept: accept ?? (wantsBinary ? "application/dicom" : "application/json"),
            },
          });

          await audit?.log({
            ...auditCommon,
            status: axiosRes.status,
            upstreamStatus: axiosRes.status,
          });

          res.statusCode = axiosRes.status;
          for (const [key, value] of Object.entries(axiosRes.headers ?? {})) {
            if (!value) continue;
            const lower = key.toLowerCase();
            if (lower === "content-length" || lower === "transfer-encoding") continue;
            if (lower.startsWith("access-control-")) continue;
            res.setHeader(key, value as any);
          }
          applyCors(res, req.headers.origin as string | undefined);
          res.setHeader("Access-Control-Expose-Headers", "*");

          if (responseType === "arraybuffer") {
            const buf = Buffer.isBuffer(axiosRes.data)
              ? axiosRes.data
              : Buffer.from(axiosRes.data as ArrayBuffer);
            res.end(buf);
          } else if (typeof axiosRes.data === "string") {
            res.end(axiosRes.data);
          } else {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(axiosRes.data));
          }
        } catch (proxyErr) {
          const message = formatAxiosError(proxyErr);
          const upstreamStatus =
            typeof (proxyErr as any)?.response?.status === "number" ? (proxyErr as any).response.status : undefined;
          res.statusCode = 502;
          res.end(`upstream error: ${message}`);
          warn(`gateway: upstream error for request ${requestId}:`, message);
          await audit?.log({
            ...auditCommon,
            status: 502,
            upstreamStatus,
            error: message,
          });
        }
        return;
      }

      res.statusCode = 404;
      res.end("Not Found");
    } catch (e: any) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain");
      res.end(e?.message || String(e));
    }
  };

  let server: any; // http.Server or https.Server
  if (deps.api?.ssl && deps.api.ssl.cert && deps.api.ssl.key) {
    const options = {
      key: readFileSync(deps.api.ssl.key),
      cert: readFileSync(deps.api.ssl.cert),
    };
    server = createHttpsServer(options, handler);
    log(`API enabled HTTPS`);
  } else {
    server = createServer(handler);
  }

  server.listen(port, host, () => {
    const protocol = deps.api?.ssl ? "https" : "http";
    log(`API listening on ${protocol}://${host}:${port}`);
    if (allowAllCors) {
      warn("CORS is set to allow all origins (*). This is not recommended for production.");
    }
  });
  return server;
}

// ========= コピー系 =========
function resolvePatientId(store: AliasStore | null, patientAddress: string): string {
  if (!store) return patientAddress;
  return store.lookup(patientAddress) ?? patientAddress;
}

async function qidoFindInstances(qido: HttpEndpoint, patientId: string): Promise<
  { sop: string; study: string; series: string }[]
> {
  const http = makeAxios(qido);
  const url = `/dicom-web/instances`;
  const params = {
    PatientID: patientId,
    includefield: "00080018,0020000D,0020000E",
    limit: 5000,
  };
  const res = await http.get(url, { params, headers: { Accept: "application/json" } });
  const arr = Array.isArray(res.data) ? res.data : [];
  const out: { sop: string; study: string; series: string }[] = [];
  for (const d of arr) {
    const sop = d?.["00080018"]?.Value?.[0];
    const study = d?.["0020000D"]?.Value?.[0];
    const series = d?.["0020000E"]?.Value?.[0];
    if (sop && study && series) out.push({ sop, study, series });
  }
  return out;
}

async function wadoFetchInstance(wado: HttpEndpoint, uids: { sop: string; study: string; series: string }) {
  const http = makeAxios(wado);
  const url = `/dicom-web/studies/${encodeURIComponent(uids.study)}/series/${encodeURIComponent(
    uids.series
  )}/instances/${encodeURIComponent(uids.sop)}`;
  const res = await http.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    headers: { Accept: "application/dicom" },
  });
  return res.data;
}

async function restFetchInstance(rest: HttpEndpoint, sopUid: string) {
  const http = makeAxios(rest);
  const lookupRes = await http.post(`/tools/lookup`, sopUid, {
    headers: { "Content-Type": "text/plain" },
  });
  const payload = Array.isArray(lookupRes.data) ? lookupRes.data : [];
  const first = payload.find((item) => typeof item === "string" || typeof item?.ID === "string");
  const instanceId = typeof first === "string" ? first : first?.ID;
  if (!instanceId) {
    throw new Error(`REST lookup did not return Orthanc ID for SOP=${sopUid}`);
  }
  const fileRes = await http.get<ArrayBuffer>(`/instances/${encodeURIComponent(instanceId)}/file`, {
    responseType: "arraybuffer",
    headers: { Accept: "application/dicom" },
  });
  return fileRes.data;
}

async function fetchInstanceWithFallback(pCfg: ProviderCfg, uids: { sop: string; study: string; series: string }) {
  try {
    return await wadoFetchInstance(pCfg.wado, uids);
  } catch (wadoErr) {
    warn(`WADO failed for ${uids.sop}. trying REST fallback...`, formatAxiosError(wadoErr));
    const restEndpoint = pCfg.rest ?? pCfg.wado;
    const data = await restFetchInstance(restEndpoint, uids.sop);
    log(`REST fallback succeeded for ${uids.sop}`);
    return data;
  }
}

async function uploadToOrthanc(orthanc: HttpEndpoint, dicomBin: ArrayBuffer | Uint8Array) {
  const http = makeAxios(orthanc);
  await http.post(`/instances`, Buffer.from(dicomBin as any), {
    headers: { "Content-Type": "application/dicom" },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
}

function buildManifestHash(success: string[], failed: string[]): string {
  const payload = JSON.stringify({
    success: [...success].sort(),
    failed: [...failed].sort(),
  });
  return keccak256(toUtf8Bytes(payload));
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function performWithRetry<T>(fn: () => Promise<T>, opts: { attempts: number; backoffMs: number; label: string }): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastErr = error;
      const message = (error as any)?.message || formatAxiosError(error);
      warn(`${opts.label} attempt ${attempt}/${opts.attempts} failed:`, message);
      if (attempt < opts.attempts) {
        const waitMs = opts.backoffMs * Math.pow(2, attempt - 1);
        await sleep(waitMs);
      }
    }
  }
  throw lastErr;
}

// ========= メイン =========
async function main() {
  const cfg = await loadConfig();
  log("config loaded");

  let normalizedContract: string;
  try {
    normalizedContract = getAddress(cfg.contractAddress);
  } catch {
    throw new Error(
      `config.json の contractAddress が不正です: ${cfg.contractAddress}\n` +
      `→ smart-contracts/deployments/localhost.json の PatientAccess を貼ってください`
    );
  }

  const aliasInitial = cfg.aliasResolver?.type === "map" ? cfg.aliasResolver.map : {};
  const aliasStore = await AliasStore.init(aliasInitial ?? {});
  const auditLogger = await AuditLogger.init(cfg.audit);

  if (cfg.audit?.retentionDays) {
    const auditFile = cfg.audit.file ? new URL(cfg.audit.file, import.meta.url) : new URL("./gateway-audit.jsonl", import.meta.url);
    const cleanupService = new CleanupService(
      dirname(fileURLToPath(auditFile)),
      cfg.audit.retentionDays
    );
    cleanupService.start();
  }

  const alertService = cfg.alerts ? new AlertService(cfg.alerts) : undefined;
  const copyEvents = new CopyEventStore(50, alertService);

  const rpcProvider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const contract = new Contract(normalizedContract, (abi as any).abi, rpcProvider) as Contract;

  const providerSignerAddresses: Record<string, string> = {};

  for (const [clinicId, clinicCfg] of Object.entries(cfg.clinics ?? {})) {
    if (!clinicCfg || clinicCfg.role !== "provider") continue;
    if (!clinicCfg.operatorAddress) {
      throw new Error(`clinics.${clinicId}.operatorAddress が設定されていません (秘密鍵は Worker に置かないでください)`);
    }
    providerSignerAddresses[clinicId] = getAddress(clinicCfg.operatorAddress);
  }

  if (!Object.keys(providerSignerAddresses).length) {
    throw new Error("provider clinic の署名者情報が config.json にありません");
  }

  // Initialize ClinicStore
  const initialClinicConfigs: Record<string, DicomNodeConfig> = {};
  for (const [pid, pCfg] of Object.entries(cfg.providers ?? {})) {
    initialClinicConfigs[pid] = {
      clinicId: pid,
      qido: {
        baseUrl: pCfg.qido.baseUrl,
        auth: pCfg.qido.auth
      },
      wado: {
        baseUrl: pCfg.wado.baseUrl,
        auth: pCfg.wado.auth
      },
      // rest is not strictly used in standard flow but we can add it if needed
    };
  }
  const clinicStore = await ClinicStore.init(initialClinicConfigs);

  const authInstance = cfg.auth?.enabled
    ? new JwtAuth(cfg.auth)
    : null;

  const signerClient = cfg.signers ? new SignerClient(cfg.signers, rpcProvider, normalizedContract) : null;
  const fulfillmentPollMs = cfg.copy?.fulfillmentPollMs ?? 1_500;
  const fulfillmentMaxAttempts = cfg.copy?.fulfillmentMaxAttempts ?? 20;
  const copyMode = cfg.copy?.mode ?? "orthanc";

  if (copyMode !== "dryRun" && !signerClient) {
    throw new Error("copy.mode が 'dryRun' 以外の場合は config.signers の設定が必要です");
  }

  async function waitForFulfilledStatus(requestId: number): Promise<void> {
    for (let attempt = 1; attempt <= fulfillmentMaxAttempts; attempt++) {
      const state = await contract.reqs(requestId);
      const status = Number(state?.status ?? 0);
      if (status >= 2) {
        return;
      }
      await sleep(fulfillmentPollMs);
    }
    throw new Error(
      `markFulfilled status not observed within ${fulfillmentMaxAttempts} attempts (interval=${fulfillmentPollMs}ms)`
    );
  }

  async function requestMarkFulfilled(
    providerId: string,
    payload: {
      requestId: number;
      manifestHash: string;
      patientAddress: string;
      patientId: string;
      success: number;
      failed: number;
    }
  ): Promise<MarkFulfilledResult> {
    if (!signerClient) {
      throw new Error("signer client is not configured (config.signers)");
    }
    if (!signerClient.hasSigner(providerId)) {
      throw new Error(`signer config not found for clinic ${providerId}`);
    }

    const result = await signerClient.markFulfilled(providerId, {
      providerId,
      requestId: payload.requestId,
      manifestHash: payload.manifestHash,
      patientAddress: payload.patientAddress,
      patientId: payload.patientId,
      success: payload.success,
      failed: payload.failed,
    });
    log(
      `markFulfilled request dispatched via external signer for id=${payload.requestId}`,
      result.txHash ? `txHash=${result.txHash}` : ""
    );
    await waitForFulfilledStatus(payload.requestId);
    return result;
  }

  const pendingPush = new Map<number, PendingPushEntry>();

  const handleProviderPush = async (envelope: ProviderPushEnvelope): Promise<ProviderPushResult> => {
    if (copyMode !== "providerPush") {
      return { status: 400, error: "copy mode is not providerPush" };
    }

    if (!envelope || typeof envelope !== "object") {
      return { status: 400, error: "invalid payload" };
    }

    const clinicId = String(envelope.clinicId ?? "").trim();
    const requestId = Number(envelope.requestId);
    const expiresAt = Number(envelope.expiresAt);

    if (!clinicId) return { status: 400, error: "clinicId is required" };
    if (!Number.isFinite(requestId)) return { status: 400, error: "requestId must be numeric" };
    if (!Number.isFinite(expiresAt)) return { status: 400, error: "expiresAt must be numeric" };
    if (!envelope.signature) return { status: 400, error: "signature is required" };

    if (!Array.isArray(envelope.instances) || envelope.instances.length === 0) {
      return { status: 400, error: "instances must be a non-empty array" };
    }

    const pending = pendingPush.get(requestId);
    if (!pending) {
      warn(`provider-push: request ${requestId} has no pending state`);
      return { status: 409, error: "no pending access request" };
    }

    if (pending.providerId !== clinicId) {
      return { status: 403, error: "clinicId mismatch" };
    }

    const expectedSigner = providerSignerAddresses[clinicId];
    if (!expectedSigner) {
      return { status: 403, error: "unknown provider clinic" };
    }

    const payloadHash = computeInstancesHash(envelope.instances);
    let recovered: string;
    try {
      const message = buildPushMessage(clinicId, requestId, expiresAt, payloadHash);
      recovered = verifyMessage(message, envelope.signature);
    } catch (e: any) {
      const message = e?.message || String(e);
      return { status: 400, error: `signature verification failed: ${message}` };
    }

    if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) {
      return { status: 403, error: "signature mismatch" };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (expiresAt < nowSec) {
      return { status: 410, error: "envelope expired" };
    }

    let reqData: any;
    try {
      reqData = await contract.reqs(requestId);
    } catch (e: any) {
      const message = e?.message || String(e);
      return { status: 500, error: `failed to load access request: ${message}` };
    }

    const status = Number(reqData?.status ?? 0);
    if (status >= 2) {
      pendingPush.delete(requestId);
      return { status: 409, error: "access request already fulfilled" };
    }

    const requesterCfg = cfg.requester?.orthanc;
    if (!requesterCfg) {
      return { status: 500, error: "requester orthanc config missing" };
    }

    const total = envelope.instances.length;
    copyEvents.update(requestId, { status: "copying", total });

    const success: string[] = [];
    const failed: string[] = [];
    const attempts = cfg.copy?.maxRetries ?? 3;
    const backoffMs = cfg.copy?.backoffMs ?? 1000;

    for (const instance of envelope.instances) {
      const sop = instance?.sop ?? "";
      if (!sop) {
        const message = "missing SOPInstanceUID";
        failed.push("(unknown)");
        copyEvents.recordFailure(requestId, { sop: "(unknown)", message });
        copyEvents.update(requestId, {
          failed: failed.length,
          success: success.length,
          status: "partial",
        });
        continue;
      }

      try {
        if (!instance.data) {
          throw new Error("instance payload missing base64 data");
        }
        const buffer = Buffer.from(instance.data, "base64");
        if (!buffer.length) {
          throw new Error("decoded payload empty");
        }

        await performWithRetry(
          () => uploadToOrthanc(requesterCfg, buffer),
          { attempts, backoffMs, label: `upload ${sop}` }
        );
        success.push(sop);
      } catch (pushErr) {
        const message = (pushErr as any)?.message || formatAxiosError(pushErr);
        failed.push(sop);
        warn(`provider-push upload failed for ${sop}:`, message);
        copyEvents.recordFailure(requestId, { sop, message });
      }

      const interimStatus: CopyEventStatus = failed.length ? "partial" : "copying";
      copyEvents.update(requestId, {
        failed: failed.length,
        success: success.length,
        status: interimStatus,
      });
    }

    const manifestHash = buildManifestHash(success, failed);
    const outcomeStatus: CopyEventStatus = failed.length ? "partial" : "completed";

    try {
      await requestMarkFulfilled(clinicId, {
        requestId,
        manifestHash,
        patientAddress: pending.patientAddress,
        patientId: pending.patientId,
        success: success.length,
        failed: failed.length,
      });
    } catch (signErr: any) {
      const message = signErr?.message || String(signErr);
      copyEvents.fail(requestId, message);
      return { status: 502, error: message };
    } finally {
      pendingPush.delete(requestId);
    }

    copyEvents.update(requestId, {
      status: outcomeStatus,
      success: success.length,
      failed: failed.length,
      manifestHash,
    });

    return {
      status: 200,
      body: {
        manifestHash,
        success: success.length,
        failed: failed.length,
        status: outcomeStatus,
      },
    };
  };

  const requesterAxios = cfg.requester?.orthanc ? makeAxios(cfg.requester.orthanc) : null;
  startApiServer(aliasStore, {
    api: cfg.api,
    contract,
    requesterAxios,
    clinics: cfg.clinics ?? {},
    audit: auditLogger,
    copyEvents,
    requesterAuth: cfg.requester?.orthanc?.auth?.type === "basic" ? cfg.requester.orthanc.auth : null,
    handleProviderPush: copyMode === "providerPush" ? handleProviderPush : undefined,
    auth: authInstance,
    clinicStore,
  });

  log("worker up:");
  log(" - contract:", normalizedContract);
  log(" - copy mode:", copyMode);
  const providerSummary = Object.entries(providerSignerAddresses)
    .map(([clinicId, address]) => `${clinicId}:${address}`)
    .join(", ");
  log(" - providers:", providerSummary || "none");

  // Look back 1000 blocks to catch events missed while worker was down
  let currentBlock = await rpcProvider.getBlockNumber();
  let fromBlock = Math.max(0, currentBlock - 1000);
  log(`listening (polling) PatientApproved from block ${fromBlock} (current: ${currentBlock})`);

  const processed = new Set<number>();
  const pollMs = 5000;

  setInterval(async () => {
    try {
      const toBlock = await rpcProvider.getBlockNumber();
      if (toBlock <= fromBlock) return;

      const events = await contract.queryFilter(contract.filters.PatientApproved(), fromBlock + 1, toBlock);

      for (const ev of events) {
        const args = (typeof ev === "object" && ev !== null && "args" in ev) ? (ev as any).args : null;
        const idBig = args?.id ?? args?.[0];
        const id = Number(idBig);
        if (!Number.isFinite(id)) continue;
        if (processed.has(id)) continue;

        log("PatientApproved", id, "at block", ev.blockNumber);
        processed.add(id);

        try {
          const { req, providerId } = await getRequestAndProviderId(contract, id, cfg, clinicStore);
          const patientAddr = req.patient as string;
          const patientId = resolvePatientId(aliasStore, patientAddr);

          copyEvents.start({ requestId: id, providerId, patientAddress: patientAddr, patientId });

          if (!providerId) {
            const message = "providerId not found in config";
            warn(`${message}; skip id=`, id);
            copyEvents.fail(id, message);
            continue;
          }

          let manifestHash: string;
          let outcomeStatus: CopyEventStatus = "completed";
          let outcomeSuccess = 0;
          let outcomeFailed = 0;

          if (copyMode === "providerPush") {
            pendingPush.set(id, {
              requestId: id,
              providerId,
              patientAddress: patientAddr,
              patientId,
            });
            copyEvents.update(id, { status: "pending", total: 0, success: 0, failed: 0 });
            log(`waiting for provider push id=${id} (clinic=${providerId})`);
            continue;
          }

          if (copyMode === "orthanc") {
            // Priority: Dynamic Store -> Static Config
            let pCfg: { qido: HttpEndpoint; wado: HttpEndpoint } | undefined = clinicStore.get(providerId);
            if (!pCfg) {
              pCfg = cfg.providers?.[providerId];
            }

            const rCfg = cfg.requester?.orthanc;
            if (!pCfg || !rCfg) {
              const message = "providers/requester config missing; fallback to dryRun";
              warn(`${message} for id=`, id);
              copyEvents.update(id, { status: "error", error: message });
              manifestHash = keccak256(toUtf8Bytes("dummy-manifest"));
              outcomeStatus = "error";
            } else {
              copyEvents.update(id, { status: "copying" });
              const instances = await qidoFindInstances(pCfg.qido, patientId);
              copyEvents.update(id, { total: instances.length });
              log(`QIDO ${providerId}: found ${instances.length} instances for PatientID=${patientId}`);

              const success: string[] = [];
              const failed: string[] = [];
              const batchSize = cfg.copy?.batchSize ?? 32;
              const attempts = cfg.copy?.maxRetries ?? 3;
              const backoffMs = cfg.copy?.backoffMs ?? 1000;

              for (let i = 0; i < instances.length; i++) {
                const u = instances[i];
                try {
                  const bin = await performWithRetry(
                    () => fetchInstanceWithFallback(pCfg, u),
                    { attempts, backoffMs, label: `fetch ${u.sop}` }
                  );
                  await performWithRetry(
                    () => uploadToOrthanc(rCfg, bin),
                    { attempts, backoffMs, label: `upload ${u.sop}` }
                  );
                  success.push(u.sop);
                } catch (copyErr) {
                  failed.push(u.sop);
                  const msg = (copyErr as any)?.message || formatAxiosError(copyErr);
                  warn(`copy failed for ${u.sop}:`, msg);
                  copyEvents.recordFailure(id, { sop: u.sop, message: msg });
                }

                const processedCount = i + 1;
                const interimStatus: CopyEventStatus = failed.length ? "partial" : "copying";
                copyEvents.update(id, {
                  success: success.length,
                  failed: failed.length,
                  status: interimStatus,
                });
                if (processedCount % batchSize === 0 || processedCount === instances.length) {
                  log(
                    `progress id=${id}: processed ${processedCount}/${instances.length} (success=${success.length}, failed=${failed.length})`
                  );
                }
              }

              if (failed.length) {
                warn(`partial success for id=${id}; failed SOPs=${failed.length}`);
              }

              manifestHash = buildManifestHash(success, failed);
              outcomeStatus = failed.length ? "partial" : "completed";
              outcomeSuccess = success.length;
              outcomeFailed = failed.length;
              copyEvents.update(id, {
                success: outcomeSuccess,
                failed: outcomeFailed,
                status: outcomeStatus,
                manifestHash,
              });
            }
          } else {
            manifestHash = keccak256(toUtf8Bytes("dry-run"));
            outcomeStatus = "completed";
            copyEvents.update(id, { status: outcomeStatus, manifestHash });
          }

          try {
            await requestMarkFulfilled(providerId, {
              requestId: id,
              manifestHash,
              patientAddress: patientAddr,
              patientId,
              success: outcomeSuccess,
              failed: outcomeFailed,
            });
            copyEvents.update(id, {
              status: outcomeStatus,
              success: outcomeSuccess,
              failed: outcomeFailed,
              manifestHash,
            });
          } catch (signErr: any) {
            const message = signErr?.message || String(signErr);
            err("markFulfilled via signer failed for id=", id, message);
            copyEvents.fail(id, message);
          }
        } catch (e: any) {
          const message = e?.reason || e?.message || String(e);
          err("fulfill failed for id=", id, ":", message);
          copyEvents.fail(id, message);
        }
      }

      fromBlock = toBlock;
    } catch (e) {
      err("poll error:", e);
    }
  }, pollMs);
}

main().catch((e) => {
  err(e);
  process.exit(1);
});
