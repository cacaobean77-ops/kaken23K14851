import React, { useEffect, useState } from "react";
import axios from "axios";

type DicomNodeConfig = {
    clinicId: string;
    aeTitle?: string;
    host?: string;
    port?: number;
    qido: { baseUrl: string; auth?: { type: "basic"; username: string; password: string } };
    wado: { baseUrl: string; auth?: { type: "basic"; username: string; password: string } };
};

export default function ClinicManager() {
    const [configs, setConfigs] = useState<DicomNodeConfig[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Form State
    const [clinicId, setClinicId] = useState("");
    const [aeTitle, setAeTitle] = useState("");
    const [host, setHost] = useState("");
    const [port, setPort] = useState<number | "">("");

    // QIDO/WADO State (simplified for PoC: assume same base URL/auth for both or auto-fill)
    const [qidoUrl, setQidoUrl] = useState("");
    const [wadoUrl, setWadoUrl] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");

    const WORKER_API = import.meta.env.VITE_WORKER_API || "http://localhost:8787";

    const fetchConfigs = async () => {
        setLoading(true);
        try {
            const res = await axios.get(`${WORKER_API}/clinics/config`);
            const list = Object.values(res.data.configs || {}) as DicomNodeConfig[];
            setConfigs(list);
            setError(null);
        } catch (err: any) {
            console.error(err);
            setError("Failed to load configs");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchConfigs();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!clinicId || !qidoUrl || !wadoUrl) {
            setError("Clinic ID, QIDO URL, and WADO URL are required.");
            return;
        }

        const payload: DicomNodeConfig = {
            clinicId,
            aeTitle: aeTitle || undefined,
            host: host || undefined,
            port: typeof port === "number" ? port : undefined,
            qido: {
                baseUrl: qidoUrl,
                auth: username ? { type: "basic", username, password } : undefined,
            },
            wado: {
                baseUrl: wadoUrl,
                auth: username ? { type: "basic", username, password } : undefined,
            },
        };

        try {
            await axios.put(`${WORKER_API}/clinics/config`, payload);
            setClinicId("");
            setAeTitle("");
            setHost("");
            setPort("");
            setQidoUrl("");
            setWadoUrl("");
            setUsername("");
            setPassword("");
            fetchConfigs();
        } catch (err: any) {
            console.error(err);
            setError("Failed to save config");
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm(`Delete config for ${id}?`)) return;
        try {
            await axios.delete(`${WORKER_API}/clinics/config/${encodeURIComponent(id)}`);
            fetchConfigs();
        } catch (err: any) {
            console.error(err);
            setError("Failed to delete config");
        }
    };

    const autofillUrls = (base: string) => {
        setHost(base.replace(/^https?:\/\//, "").split(":")[0]);
        setQidoUrl(base);
        setWadoUrl(base);
    };

    return (
        <div className="bg-white p-6 rounded shadow space-y-4">
            <h2 className="text-xl font-bold mb-4">DICOM Network Configuration</h2>

            {error && (
                <div className="bg-red-100 text-red-700 p-2 rounded text-sm">
                    {error}
                </div>
            )}

            {/* List */}
            <div className="overflow-x-auto">
                <table className="min-w-full text-sm text-left border">
                    <thead className="bg-gray-100 border-b">
                        <tr>
                            <th className="p-2 border-r">Clinic ID</th>
                            <th className="p-2 border-r">AE Title</th>
                            <th className="p-2 border-r">Host/Port</th>
                            <th className="p-2 border-r">QIDO / WADO</th>
                            <th className="p-2">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {configs.length === 0 && (
                            <tr>
                                <td colSpan={5} className="p-4 text-center text-gray-500">
                                    No configurations found.
                                </td>
                            </tr>
                        )}
                        {configs.map((c) => (
                            <tr key={c.clinicId} className="border-b hover:bg-gray-50">
                                <td className="p-2 border-r font-medium">{c.clinicId}</td>
                                <td className="p-2 border-r">{c.aeTitle || "-"}</td>
                                <td className="p-2 border-r">
                                    {c.host ? `${c.host}:${c.port || ""}` : "-"}
                                </td>
                                <td className="p-2 border-r max-w-xs truncate" title={`QIDO: ${c.qido.baseUrl}\nWADO: ${c.wado.baseUrl}`}>
                                    <div className="text-xs text-gray-600">Q: {c.qido.baseUrl}</div>
                                    <div className="text-xs text-gray-600">W: {c.wado.baseUrl}</div>
                                </td>
                                <td className="p-2">
                                    <button
                                        onClick={() => handleDelete(c.clinicId)}
                                        className="text-red-600 hover:text-red-800 underline"
                                    >
                                        Delete
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <hr />

            {/* Add Form */}
            <h3 className="font-semibold">Add / Update Configuration</h3>
            <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium">Clinic ID *</label>
                        <input
                            type="text"
                            className="border p-2 rounded w-full"
                            placeholder="e.g. PROV-002"
                            value={clinicId}
                            onChange={(e) => setClinicId(e.target.value)}
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium">AE Title</label>
                        <input
                            type="text"
                            className="border p-2 rounded w-full"
                            placeholder="ORTHANC"
                            value={aeTitle}
                            onChange={(e) => setAeTitle(e.target.value)}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium">Host IP/Domain</label>
                        <input
                            type="text"
                            className="border p-2 rounded w-full"
                            placeholder="192.168.1.10"
                            value={host}
                            onChange={(e) => {
                                setHost(e.target.value);
                                if (!qidoUrl && e.target.value) {
                                    // small helper
                                    const url = `http://${e.target.value}:8042`;
                                    setQidoUrl(url);
                                    setWadoUrl(url);
                                }
                            }}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium">Port</label>
                        <input
                            type="number"
                            className="border p-2 rounded w-full"
                            placeholder="8042"
                            value={port}
                            onChange={(e) => setPort(e.target.valueAsNumber || "")}
                        />
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium">QIDO URL *</label>
                        <input
                            type="url"
                            className="border p-2 rounded w-full"
                            placeholder="http://localhost:8042"
                            value={qidoUrl}
                            onChange={(e) => setQidoUrl(e.target.value)}
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium">WADO URL *</label>
                        <input
                            type="url"
                            className="border p-2 rounded w-full"
                            placeholder="http://localhost:8042"
                            value={wadoUrl}
                            onChange={(e) => setWadoUrl(e.target.value)}
                            required
                        />
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium">Username (Basic Auth)</label>
                        <input
                            type="text"
                            className="border p-2 rounded w-full"
                            autoComplete="off"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium">Password</label>
                        <input
                            type="password"
                            className="border p-2 rounded w-full"
                            autoComplete="off"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    </div>
                </div>

                <button
                    type="submit"
                    className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 font-medium"
                >
                    Save Configuration
                </button>
            </form>
        </div>
    );
}
