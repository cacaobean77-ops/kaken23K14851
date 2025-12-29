import React, { useState, useEffect } from "react";

type AuditLogEntry = {
    timestamp: string;
    method: string;
    path: string;
    requestId: number;
    status: number;
    error?: string;
    clientIp?: string;
    subject?: string;
};

export default function AuditLogViewer() {
    const [token, setToken] = useState("");
    const [logs, setLogs] = useState<AuditLogEntry[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const workerEndpoint = import.meta.env.VITE_WORKER_API as string | undefined;

    const fetchLogs = async () => {
        if (!workerEndpoint) {
            setError("VITE_WORKER_API is not set");
            return;
        }
        if (!token) {
            setError("Admin Token is required");
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const res = await fetch(`${workerEndpoint.replace(/\/+$/, "")}/audit-logs?limit=100`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            }

            const data = await res.json();
            setLogs(data.logs || []);
        } catch (err: any) {
            setError(err.message || String(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-4 border rounded shadow-sm bg-white">
            <h2 className="text-xl font-bold mb-4">Audit Logs (Admin)</h2>

            <div className="flex gap-2 mb-4">
                <input
                    type="password"
                    className="border p-2 rounded flex-1"
                    placeholder="Admin Bearer Token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                />
                <button
                    className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
                    onClick={fetchLogs}
                    disabled={loading || !token}
                >
                    {loading ? "Loading..." : "Fetch Logs"}
                </button>
            </div>

            {error && <div className="text-red-600 mb-4">{error}</div>}

            <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse border">
                    <thead className="bg-gray-100">
                        <tr>
                            <th className="border p-2 text-left">Timestamp</th>
                            <th className="border p-2 text-left">Method</th>
                            <th className="border p-2 text-left">Path</th>
                            <th className="border p-2 text-left">Status</th>
                            <th className="border p-2 text-left">User</th>
                            <th className="border p-2 text-left">IP</th>
                            <th className="border p-2 text-left">Error</th>
                        </tr>
                    </thead>
                    <tbody>
                        {logs.length === 0 && !loading && (
                            <tr>
                                <td colSpan={7} className="p-4 text-center opacity-70">
                                    No logs loaded.
                                </td>
                            </tr>
                        )}
                        {logs.map((log, idx) => (
                            <tr key={idx} className={log.status >= 400 ? "bg-red-50" : ""}>
                                <td className="border p-2 whitespace-nowrap">
                                    {new Date(log.timestamp).toLocaleString()}
                                </td>
                                <td className="border p-2 font-mono">{log.method}</td>
                                <td className="border p-2 font-mono break-all max-w-xs">{log.path}</td>
                                <td className={`border p-2 font-bold ${log.status >= 400 ? "text-red-600" : "text-green-600"}`}>
                                    {log.status}
                                </td>
                                <td className="border p-2 font-mono">{log.subject || "-"}</td>
                                <td className="border p-2 font-mono">{log.clientIp || "-"}</td>
                                <td className="border p-2 text-red-600 break-all max-w-xs">{log.error}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
