import { IncomingMessage } from "node:http";
import { createPublicKey, createVerify } from "node:crypto";
import { Buffer } from "node:buffer";

export type Jwk = {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
  use?: string;
};

export type AuthRouteRule = {
  path: string;
  methods?: string[];
  requiredRoles?: string[];
  allowUnauthenticated?: boolean;
};

export type AuthConfig = {
  enabled?: boolean;
  issuer?: string;
  audience?: string | string[];
  clockSkewSeconds?: number;
  roleClaim?: string;
  additionalRoleClaims?: string[];
  jwks: { keys: Jwk[] };
  routes?: AuthRouteRule[];
};

export type Principal = {
  subject: string;
  roles: string[];
  claims: Record<string, any>;
  token: string;
  clinicId?: string;
};

type KeyHolder = {
  kid?: string;
  alg?: string;
  key: ReturnType<typeof createPublicKey>;
};

const DEFAULT_ROLE_CLAIM = "realm_access.roles";

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = 4 - (normalized.length % 4 || 4);
  const padded = normalized + "=".repeat(padLength === 4 ? 0 : padLength);
  return Buffer.from(padded, "base64");
}

function getClaim(payload: Record<string, any>, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split(".").filter(Boolean);
  let current: any = payload;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function ensureArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim().split(/\s+/);
  }
  return [];
}

export class JwtAuth {
  private readonly keys: KeyHolder[] = [];
  private readonly config: AuthConfig;

  constructor(config: AuthConfig) {
    if (!config?.jwks?.keys?.length) {
      throw new Error("auth.jwks.keys が設定されていません");
    }
    this.config = {
      clockSkewSeconds: 60,
      roleClaim: DEFAULT_ROLE_CLAIM,
      ...config,
    };

    for (const jwk of config.jwks.keys) {
      try {
        const keyObject = createPublicKey({ key: jwk as any, format: "jwk" });
        this.keys.push({ kid: jwk.kid, alg: jwk.alg, key: keyObject });
      } catch (e) {
        throw new Error(`JWK の読み込みに失敗しました (kid=${jwk.kid ?? "n/a"}): ${e}`);
      }
    }

    if (!this.keys.length) {
      throw new Error("有効な JWK がありません");
    }
  }

  matchRoute(pathname: string, method: string): AuthRouteRule | undefined {
    if (!this.config.routes?.length) return undefined;
    const normalisedMethod = method.toUpperCase();
    return this.config.routes.find((rule) => {
      const methodOk = !rule.methods?.length || rule.methods.includes(normalisedMethod);
      const pathOk = pathname === rule.path || pathname.startsWith(rule.path.endsWith("/") ? rule.path : `${rule.path}`);
      return methodOk && pathOk;
    });
  }

  verifyHeader(req: IncomingMessage): { ok: false; status: number; message: string } | { ok: true; token: string } {
    const authHeader = req.headers["authorization"];
    if (typeof authHeader !== "string") {
      return { ok: false, status: 401, message: "missing Authorization header" };
    }
    const [scheme, token] = authHeader.split(" ");
    if (!token || scheme.toLowerCase() !== "bearer") {
      return { ok: false, status: 401, message: "invalid Authorization header" };
    }
    return { ok: true, token };
  }

  verifyToken(token: string): { ok: true; principal: Principal } | { ok: false; status: number; message: string } {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, status: 401, message: "invalid JWT format" };
    }
    const [headerB64, payloadB64, signatureB64] = parts;

    let header: Record<string, any>;
    let payload: Record<string, any>;
    try {
      header = JSON.parse(base64UrlDecode(headerB64).toString("utf-8"));
      payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf-8"));
    } catch (e) {
      return { ok: false, status: 401, message: `invalid JWT encoding: ${e}` };
    }

    const alg = header.alg;
    const kid = header.kid;
    if (!alg) {
      return { ok: false, status: 401, message: "JWT alg is missing" };
    }

    const candidateKeys = this.keys.filter((k) => (!kid || k.kid === kid) && (!k.alg || k.alg === alg));
    if (!candidateKeys.length) {
      return { ok: false, status: 401, message: "no matching key for JWT" };
    }

    const signature = base64UrlDecode(signatureB64);
    const signedPart = Buffer.from(`${headerB64}.${payloadB64}`, "utf-8");

    const verified = candidateKeys.some((entry) => {
      const verifier = createVerify(this.mapAlgToNode(alg));
      verifier.update(signedPart);
      verifier.end();
      return verifier.verify(entry.key, signature);
    });

    if (!verified) {
      return { ok: false, status: 401, message: "JWT signature verification failed" };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const skew = this.config.clockSkewSeconds ?? 60;

    if (typeof payload.exp === "number" && nowSec - skew >= payload.exp) {
      return { ok: false, status: 401, message: "JWT expired" };
    }

    if (typeof payload.nbf === "number" && nowSec + skew < payload.nbf) {
      return { ok: false, status: 401, message: "JWT not yet valid" };
    }

    if (this.config.issuer && payload.iss && payload.iss !== this.config.issuer) {
      return { ok: false, status: 401, message: "JWT issuer mismatch" };
    }

    if (this.config.audience) {
      const expectedAud = Array.isArray(this.config.audience) ? this.config.audience : [this.config.audience];
      const tokenAud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      const matches = expectedAud.some((aud) => tokenAud.includes(aud));
      if (!matches) {
        return { ok: false, status: 401, message: "JWT audience mismatch" };
      }
    }

    const rolePaths = [this.config.roleClaim ?? DEFAULT_ROLE_CLAIM, ...(this.config.additionalRoleClaims ?? [])];
    const roles = rolePaths.flatMap((path) => ensureArray(getClaim(payload, path) ?? [])).filter(Boolean);

    const principal: Principal = {
      subject: String(payload.sub ?? ""),
      roles,
      claims: payload,
      token,
      clinicId: getClaim(payload, "clinic_id") as string | undefined, // Extract clinic_id
    };
    return { ok: true, principal };
  }

  private mapAlgToNode(alg: string): string {
    switch (alg) {
      case "RS256":
        return "RSA-SHA256";
      case "RS384":
        return "RSA-SHA384";
      case "RS512":
        return "RSA-SHA512";
      default:
        throw new Error(`unsupported JWT alg: ${alg}`);
    }
  }
}

export type AuthResult = {
  ok: boolean;
  status?: number;
  message?: string;
  principal?: Principal;
};

export async function requireAuth(
  req: IncomingMessage,
  res: { statusCode: number; end: (msg?: any) => void } & { setHeader(name: string, value: string): void },
  auth: JwtAuth | null | undefined,
  requiredRoles?: string[]
): Promise<AuthResult> {
  if (!auth) {
    return { ok: true };
  }

  const headerCheck = auth.verifyHeader(req);
  if (!headerCheck.ok) {
    res.statusCode = headerCheck.status;
    res.setHeader("WWW-Authenticate", "Bearer");
    res.end(headerCheck.message);
    return { ok: false, status: headerCheck.status, message: headerCheck.message };
  }

  const verify = auth.verifyToken(headerCheck.token);
  if (!verify.ok) {
    res.statusCode = verify.status;
    res.setHeader("WWW-Authenticate", "Bearer error=invalid_token");
    res.end(verify.message);
    return { ok: false, status: verify.status, message: verify.message };
  }

  const principal = verify.principal;
  if (!principal.subject) {
    res.statusCode = 401;
    res.end("JWT subject missing");
    return { ok: false, status: 401, message: "JWT subject missing" };
  }

  if (requiredRoles?.length) {
    const granted = requiredRoles.some((role) => principal.roles.includes(role));
    if (!granted) {
      res.statusCode = 403;
      res.end("forbidden: insufficient role");
      return { ok: false, status: 403, message: "insufficient role" };
    }
  }

  return { ok: true, principal };
}

