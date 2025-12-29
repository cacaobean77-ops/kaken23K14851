import { AuditLogger } from '../audit-logger.js';
import { CleanupService } from '../cleanup-service.js';
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(fileURLToPath(new URL(".", import.meta.url)));

// Mock config for testing
const testDir = join(__dirname, "temp-test-data");
const auditFile = join(testDir, "test-audit.jsonl");

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function testEncryption() {
    console.log("=== Testing Encryption ===");
    const keyHex = randomBytes(32).toString("hex");
    const logger = await AuditLogger.init({
        file: auditFile,
        encryptionKey: keyHex
    });

    const entry = {
        timestamp: new Date().toISOString(),
        method: "GET",
        path: "/test",
        forwardPath: "/test",
        requestId: 123,
        patientAddress: "0xTest",
        patientId: "test-patient",
        status: 200,
    };

    await logger.log(entry);

    const content = await readFile(auditFile, "utf-8");
    console.log("Encrypted content line:", content.trim());
    const parsed = JSON.parse(content.trim());

    if (parsed.patientId === "test-patient") {
        throw new Error("FAIL: Content appears unencrypted!");
    }
    if (!parsed.iv || !parsed.tag || !parsed.data) {
        throw new Error("FAIL: Missing encryption fields");
    }

    // Test decryption via read()
    const logs = await logger.read(10);
    console.log("Decrypted log:", logs[0]);
    if (logs[0].patientId !== "test-patient") {
        throw new Error("FAIL: Decryption unsuccessful");
    }
    console.log("PASS: Encryption/Decryption works");
}

async function testCleanup() {
    console.log("=== Testing Cleanup ===");
    const service = new CleanupService(testDir, 0); // 0 days retention

    // Create old file (fake timestamp?)
    // Actually CleanupService uses file mtime. We need to touch it to be old?
    // Or since retention is 0 days, immediate creation is "0 days old", so wait a bit?
    // Wait, 0 days means > 0 days.
    // We can't fake mtime easily without `utimes`.

    const oldFile = join(testDir, "gateway-audit.jsonl.1");
    await writeFile(oldFile, "dummy");

    // Set mtime to 2 days ago
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    await import("node:fs/promises").then(fs => fs.utimes(oldFile, twoDaysAgo, twoDaysAgo));

    console.log("Created old file:", oldFile);

    await service["run"](); // Force run private method if possible, or use start/sleep

    try {
        await readFile(oldFile);
        throw new Error("FAIL: File still exists");
    } catch (e: any) {
        if (e.code === "ENOENT") {
            console.log("PASS: File deleted");
        } else {
            throw e;
        }
    }
    service.stop();
}

async function run() {
    try {
        await rm(testDir, { recursive: true, force: true });
        await mkdir(testDir, { recursive: true });

        // Testing logic needs classes to be exported from index.ts
        // Since index.ts is a module, I need to check if they are exported.
        // If NOT, I might need to temporarily export them or move to separate files.

        // For now assuming I need to export them.
        await testEncryption();
        await testCleanup();

    } catch (e) {
        console.error(e);
        process.exit(1);
    } finally {
        // await rm(testDir, { recursive: true, force: true });
    }
}

run();
