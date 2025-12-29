import { readFile, appendFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type AuditLogEntry = {
    timestamp: string;
    method: string;
    path: string;
    forwardPath: string;
    requestId: number;
    patientAddress: string;
    patientId: string;
    query?: Record<string, string>;
    status: number;
    upstreamStatus?: number;
    error?: string;
    subject?: string;
    roles?: string[];
    clientIp?: string;
    authError?: string;
};

export type AuditCfg = {
    file?: string;
    retentionDays?: number;
    encryptionKey?: string;
};

export class AuditLogger {
    private readonly encryptionKey?: Buffer;

    private constructor(private readonly fileUrl: URL, encryptionKeyHex?: string) {
        if (encryptionKeyHex) {
            if (encryptionKeyHex.length !== 64) {
                throw new Error("audit.encryptionKey must be 64 hex characters (32 bytes)");
            }
            this.encryptionKey = Buffer.from(encryptionKeyHex, "hex");
        }
    }

    static async init(cfg?: AuditCfg): Promise<AuditLogger> {
        const targetUrl = cfg?.file ? new URL(cfg.file, import.meta.url) : new URL("./gateway-audit.jsonl", import.meta.url);
        const dir = dirname(fileURLToPath(targetUrl));
        await mkdir(dir, { recursive: true });
        return new AuditLogger(targetUrl, cfg?.encryptionKey);
    }

    async log(entry: AuditLogEntry): Promise<void> {
        let serialised = JSON.stringify(entry);

        if (this.encryptionKey) {
            const iv = randomBytes(16);
            const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
            let encrypted = cipher.update(serialised, "utf8", "hex");
            encrypted += cipher.final("hex");
            const authTag = cipher.getAuthTag().toString("hex");

            serialised = JSON.stringify({
                v: 1,
                iv: iv.toString("hex"),
                tag: authTag,
                data: encrypted
            });
        }

        try {
            await this.rotateIfNeeded();
            await appendFile(this.fileUrl, serialised + "\n", "utf-8");
        } catch (e) {
            console.error("audit log write failed", e);
        }
    }

    private async rotateIfNeeded() {
        try {
            const stats = await stat(this.fileUrl);
            if (stats.size > 10 * 1024 * 1024) { // 10MB
                const basePath = fileURLToPath(this.fileUrl);
                const maxBackups = 5;
                try {
                    await unlink(`${basePath}.${maxBackups}`);
                } catch (_) { /* ignore */ }
                for (let i = maxBackups - 1; i >= 1; i--) {
                    try {
                        await rename(`${basePath}.${i}`, `${basePath}.${i + 1}`);
                    } catch (_) { /* ignore */ }
                }
                await rename(basePath, `${basePath}.1`);
            }
        } catch (e: any) {
            if (e.code !== "ENOENT") {
                console.warn("audit log rotation check failed", e);
            }
        }
    }

    async read(limit: number = 100): Promise<AuditLogEntry[]> {
        try {
            const content = await readFile(this.fileUrl, "utf-8");
            const lines = content.split("\n").filter((line) => line.trim());
            // Reverse to get newest first
            return lines
                .reverse()
                .slice(0, limit)
                .map((line) => {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.v === 1 && parsed.iv && parsed.tag && parsed.data && this.encryptionKey) {
                            const iv = Buffer.from(parsed.iv, "hex");
                            const authTag = Buffer.from(parsed.tag, "hex");
                            const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
                            decipher.setAuthTag(authTag);
                            let decrypted = decipher.update(parsed.data, "hex", "utf8");
                            decrypted += decipher.final("utf8");
                            return JSON.parse(decrypted);
                        }
                        return parsed;
                    } catch {
                        return null;
                    }
                })
                .filter((entry): entry is AuditLogEntry => entry !== null);
        } catch (e: any) {
            if (e.code === "ENOENT") return [];
            throw e;
        }
    }
}
