#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function ensureAddress(label, value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} address is invalid: ${value}`);
  }
  return value;
}

const repoRoot = path.resolve(__dirname, '..', '..');
const deploymentPath = path.resolve(__dirname, '../deployments/localhost.json');
const envPath = path.resolve(repoRoot, 'webapp/.env.local');
const workerCfgPath = path.resolve(repoRoot, 'worker/config.json');

const defaultEnv = [
  'VITE_ORTHANC_BASE_RQ=/secure',
  'VITE_ORTHANC_USER=',
  'VITE_ORTHANC_PASS=',
  'VITE_OHIF_URL=http://localhost:3000',
  'VITE_RQ_DICOMWEB=http://localhost:8787/secure/{requestId}/dicom-web',
  'VITE_WORKER_API=http://localhost:8787',
];

const deployment = readJson(deploymentPath);
const patientAccess = ensureAddress('PatientAccess', deployment.PatientAccess);
const mockErc20 = ensureAddress('MockERC20', deployment.MockERC20);

// ---- update webapp/.env.local ----
if (fs.existsSync(envPath)) {
  const seenKeys = new Set();
  const original = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const kv = new Map(
    original
      .map((line) => {
        const [key, ...rest] = line.split('=');
        if (!key) return null;
        seenKeys.add(key.trim());
        return [key.trim(), rest.join('=')];
      })
      .filter(Boolean)
  );

  kv.set('VITE_CONTRACT', patientAccess);
  for (const entry of defaultEnv) {
    const [key, value] = entry.split('=');
    kv.set(key, value);
  }

  const serialized = Array.from(kv.entries()).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, serialized.join('\n') + '\n', 'utf8');
} else {
  const lines = [`VITE_CONTRACT=${patientAccess}`, ...defaultEnv];
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
}

// ---- update worker/config.json ----
if (fs.existsSync(workerCfgPath)) {
  const workerCfg = readJson(workerCfgPath);
  workerCfg.contractAddress = patientAccess;
  if (workerCfg.clinics && typeof workerCfg.clinics === 'object') {
    for (const clinicId of Object.keys(workerCfg.clinics)) {
      const clinic = workerCfg.clinics[clinicId];
      if (clinic && typeof clinic === 'object' && 'priceToken' in clinic) {
        clinic.priceToken = mockErc20;
      }
    }
  }
  writeJson(workerCfgPath, workerCfg);
}

console.log('Synced addresses to webapp/.env.local and worker/config.json');
