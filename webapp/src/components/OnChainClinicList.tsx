import React, { useEffect, useState } from 'react';
import { ethers, Contract } from 'ethers';

interface Window {
    ethereum?: any;
}


// Minimal ABI for events and querying clinics
const ABI = [
    "event ClinicRegistered(bytes32 indexed clinicKey, string clinicId, address payout, address operator)",
    "function clinics(bytes32 key) view returns (bool registered, string clinicId, address payout, address operator)"
];

interface ClinicData {
    clinicId: string;
    clinicKey: string;
    payout: string;
    operator: string;
}

const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT;

export const OnChainClinicList: React.FC = () => {
    const [clinics, setClinics] = useState<ClinicData[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>("");

    useEffect(() => {
        loadClinics();
    }, []);

    const loadClinics = async () => {
        const ethereum = (window as any).ethereum;
        if (!ethereum) {
            setError("No crypto wallet found. Please install MetaMask.");
            return;
        }
        setLoading(true);
        try {
            const provider = new ethers.BrowserProvider(ethereum);
            const contract = new Contract(CONTRACT_ADDRESS, ABI, provider);

            // Fetch all ClinicRegistered events
            // In a real large-scale app, we might need pagination or indexing.
            // For this project scale, querying from block 0 (or deployment block) is fine.
            const filter = contract.filters.ClinicRegistered();
            const events = await contract.queryFilter(filter);

            const uniqueClinics = new Map<string, ClinicData>();

            for (const event of events) {
                if ('args' in event) {
                    const { clinicKey, clinicId, payout, operator } = event.args as any;
                    // We rely on the event for the ID. 
                    // To be 100% sure of current state (updates), we could call contract.clinics(clinicKey),
                    // but the event gives us the ID which is the main request.
                    // Let's rely on event data for now for speed, assuming IDs don't change keys.
                    // If overwrite happens with same key, we just take the latest event? 
                    // Actually, let's just show unique IDs found.
                    uniqueClinics.set(clinicKey, { clinicKey, clinicId, payout, operator });
                }
            }

            // Optional: Update with latest state from 'clinics' mapping if needed. 
            // For now, list unique clinics found.
            setClinics(Array.from(uniqueClinics.values()));
        } catch (err: any) {
            console.error(err);
            setError(err.message || "Failed to load clinics");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
            <h1>On-Chain Registered Clinics</h1>
            {error && <div style={{ color: 'red', marginBottom: '10px' }}>{error}</div>}
            {loading && <div>Loading blockchain events...</div>}

            {!loading && (
                <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '10px' }}>
                    <thead>
                        <tr style={{ background: '#f0f0f0' }}>
                            <th style={thStyle}>Clinic ID</th>
                            <th style={thStyle}>Payout Address</th>
                            <th style={thStyle}>Operator Address</th>
                            <th style={thStyle}>Key Hash</th>
                        </tr>
                    </thead>
                    <tbody>
                        {clinics.map(c => (
                            <tr key={c.clinicKey}>
                                <td style={tdStyle}><strong>{c.clinicId}</strong></td>
                                <td style={tdStyle}>{c.payout}</td>
                                <td style={tdStyle}>{c.operator}</td>
                                <td style={tdStyle}><small>{c.clinicKey.substring(0, 10)}...</small></td>
                            </tr>
                        ))}
                        {clinics.length === 0 && <tr><td colSpan={4} style={tdStyle}>No clinics found.</td></tr>}
                    </tbody>
                </table>
            )}
        </div>
    );
};

const thStyle = { border: '1px solid #ddd', padding: '8px', textAlign: 'left' as const };
const tdStyle = { border: '1px solid #ddd', padding: '8px' };
