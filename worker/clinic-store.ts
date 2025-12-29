import { readFile, writeFile } from "node:fs/promises";
import { keccak256, toUtf8Bytes } from "ethers";

export type DicomNodeConfig = {
    clinicId: string;
    aeTitle?: string;
    host?: string;
    port?: number;
    qido: { baseUrl: string; auth?: { type: "basic"; username: string; password: string } };
    wado: { baseUrl: string; auth?: { type: "basic"; username: string; password: string } };
};

export class ClinicStore {
    private map: Record<string, DicomNodeConfig> = {};

    private constructor(private readonly fileUrl: URL, initial: Record<string, DicomNodeConfig>) {
        this.map = { ...initial };
    }

    static async init(initialFromConfig: Record<string, DicomNodeConfig> = {}): Promise<ClinicStore> {
        const fileUrl = new URL("./dicom-config.json", import.meta.url);
        let persisted: Record<string, DicomNodeConfig> = {};
        try {
            const raw = await readFile(fileUrl, "utf-8");
            persisted = JSON.parse(raw);
        } catch (e: any) {
            if (e?.code !== "ENOENT") {
                console.warn("dicom-config.json 読み込みに失敗しました", e);
            }
        }
        // Persisted config takes precedence, but we also keep config.json entries
        // that are not in persisted. However, for a user-editable system,
        // we might want persisted to simply extend/override.
        // For now, merged = initial + persisted (persisted overrides same keys).
        const merged = { ...initialFromConfig, ...persisted };
        const store = new ClinicStore(fileUrl, merged);

        // Ensure persistence file exists with current state
        await store.persist();
        return store;
    }

    list(): Record<string, DicomNodeConfig> {
        return { ...this.map };
    }

    get(clinicId: string): DicomNodeConfig | undefined {
        return this.map[clinicId];
    }

    /**
     * Fuzzy lookup by clinic ID hash (used in smart contract)
     */
    findByHash(clinicIdHash: string): DicomNodeConfig | undefined {
        const lowerHash = clinicIdHash.toLowerCase();
        return Object.values(this.map).find(
            (c) => keccak256(toUtf8Bytes(c.clinicId)).toLowerCase() === lowerHash
        );
    }

    async set(config: DicomNodeConfig) {
        if (!config.clinicId) throw new Error("clinicId is required");
        this.map[config.clinicId] = config;
        await this.persist();
    }

    async remove(clinicId: string) {
        if (this.map[clinicId]) {
            delete this.map[clinicId];
            await this.persist();
        }
    }

    private async persist() {
        await writeFile(this.fileUrl, JSON.stringify(this.map, null, 2) + "\n", "utf-8");
    }
}
