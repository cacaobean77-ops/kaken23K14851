import React, { useState } from "react";
import ProviderSettings from "./components/ProviderSettings";
import RequesterDashboard from "./components/RequesterDashboard";
import PatientApprovals from "./components/PatientApprovals";
import OrthancBrowser from "./components/OrthancBrowser";
import AliasManager from "./components/AliasManager";
import ClinicManager from "./components/ClinicManager";
import AuditLogViewer from "./components/AuditLogViewer";
import { OnChainClinicList } from './components/OnChainClinicList';

export default function App() {
  const contractAddress = import.meta.env.VITE_CONTRACT as string;
  const ohifUrl = import.meta.env.VITE_OHIF_URL as string | undefined;

  // Tabs: 'patient', 'requester', 'settings'
  const [activeTab, setActiveTab] = useState<"patient" | "requester" | "settings">("patient");

  // Simple routing hack for the popup window
  if (window.location.pathname === "/on-chain-clinics") {
    return <OnChainClinicList />;
  }

  const tabStyle = (tab: string): React.CSSProperties => ({
    padding: "10px 20px",
    cursor: "pointer",
    borderBottom: activeTab === tab ? "2px solid blue" : "transparent",
    fontWeight: activeTab === tab ? "bold" : "normal",
    background: "none",
    border: "none",
    borderBottomWidth: "2px",
    borderBottomStyle: "solid",
    borderBottomColor: activeTab === tab ? "#2563eb" : "transparent", // Tailwind blue-600
    color: activeTab === tab ? "#1e40af" : "#4b5563", // Tailwind blue-800 vs gray-600
    outline: "none"
  });

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6 font-sans text-gray-800">
      <header className="space-y-4 border-b pb-4">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold">DICOM Flow WebApp</h1>
            <div className="text-sm opacity-70 mt-1">
              Contract: <span className="font-mono text-xs bg-gray-100 p-1 rounded">{contractAddress}</span>
            </div>
          </div>
          {ohifUrl && (
            <a
              className="text-blue-600 hover:underline text-sm"
              href={ohifUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open OHIF Viewer &rarr;
            </a>
          )}
        </div>

        {/* Tab Navigation */}
        <div className="flex space-x-4 mt-4 border-b border-gray-200">
          <button style={tabStyle("patient")} onClick={() => setActiveTab("patient")}>
            Patient
          </button>
          <button style={tabStyle("requester")} onClick={() => setActiveTab("requester")}>
            Requester
          </button>
          <button style={tabStyle("settings")} onClick={() => setActiveTab("settings")}>
            Settings & Admin
          </button>
        </div>
      </header>

      {/* Tab Content */}
      <main className="min-h-[500px]">
        {activeTab === "patient" && (
          <section className="space-y-8 animate-fade-in">
            <div>
              <h2 className="text-xl font-semibold mb-4">Patient Approvals</h2>
              <PatientApprovals contractAddress={contractAddress} />
            </div>
          </section>
        )}

        {activeTab === "requester" && (
          <section className="space-y-8 animate-fade-in">
            <div>
              <h2 className="text-xl font-semibold mb-4">Request Data</h2>
              <RequesterDashboard contractAddress={contractAddress} />
            </div>
            <hr className="border-gray-200" />
            <div>
              <h2 className="text-xl font-semibold mb-4">My Images (Orthanc)</h2>
              <OrthancBrowser contractAddress={contractAddress} />
            </div>
          </section>
        )}

        {activeTab === "settings" && (
          <section className="space-y-12 animate-fade-in">
            <div>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-semibold">Tools</h2>
                <button
                  onClick={() => window.open('/on-chain-clinics', '_blank', 'width=900,height=600')}
                  className="bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold py-2 px-4 border border-gray-400 rounded shadow text-sm"
                >
                  View On-Chain Clinics (Popup)
                </button>
              </div>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-4 text-gray-700 border-b pb-2">Provider Settings</h2>
              <ProviderSettings contractAddress={contractAddress} />
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-4 text-gray-700 border-b pb-2">Clinic Configuration (Admin)</h2>
              <ClinicManager />
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-4 text-gray-700 border-b pb-2">Patient Alias Linking (Admin)</h2>
              <AliasManager />
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-4 text-gray-700 border-b pb-2">Audit Logs</h2>
              <AuditLogViewer />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
