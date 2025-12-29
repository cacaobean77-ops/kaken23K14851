import { readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class CleanupService {
    private intervalId?: NodeJS.Timeout;

    constructor(
        private readonly targetDir: string,
        private readonly retentionDays: number,
        private readonly pattern: RegExp = /^gateway-audit\.jsonl\.\d+$/
    ) { }

    start(intervalMs = 24 * 60 * 60 * 1000) {
        if (this.intervalId) return;
        this.run(); // Run immediately on start
        this.intervalId = setInterval(() => this.run(), intervalMs);
        console.log(`[CleanupService] Started. Retention: ${this.retentionDays} days.`);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }

    private async run() {
        try {
            const now = Date.now();
            const files = await readdir(this.targetDir);
            let deletedCount = 0;

            for (const file of files) {
                if (!this.pattern.test(file)) continue;

                const filePath = join(this.targetDir, file);
                try {
                    const stats = await stat(filePath);
                    const ageMs = now - stats.mtimeMs;
                    const ageDays = ageMs / (1000 * 60 * 60 * 24);

                    if (ageDays > this.retentionDays) {
                        await unlink(filePath);
                        console.log(`[CleanupService] Deleted old log file: ${file} (${ageDays.toFixed(1)} days old)`);
                        deletedCount++;
                    }
                } catch (e: any) {
                    console.warn(`[CleanupService] Failed to check/delete ${file}:`, e.message);
                }
            }

            if (deletedCount > 0) {
                console.log(`[CleanupService] Cleanup completed. Deleted ${deletedCount} files.`);
            }
        } catch (e: any) {
            console.error("[CleanupService] Error during cleanup:", e);
        }
    }
}
