import { keccak256, toUtf8Bytes } from "ethers";

export type ProviderPushInstance = {
  sop: string;
  study?: string;
  series?: string;
  data: string; // base64 encoded DICOM payload
};

export type ProviderPushEnvelope = {
  clinicId: string;
  requestId: number;
  expiresAt: number;
  instances: ProviderPushInstance[];
  signature: string;
};

function canonicalise(instances: ProviderPushInstance[]) {
  const entries = instances.map((instance) => ({
    sop: instance.sop,
    study: instance.study ?? null,
    series: instance.series ?? null,
    dataHash: keccak256(toUtf8Bytes(instance.data ?? "")),
  }));
  entries.sort((a, b) => a.sop.localeCompare(b.sop));
  return entries;
}

export function computeInstancesHash(instances: ProviderPushInstance[]): string {
  const canonical = canonicalise(instances);
  return keccak256(toUtf8Bytes(JSON.stringify(canonical)));
}

export function buildPushMessage(
  clinicId: string,
  requestId: number,
  expiresAt: number,
  payloadHash: string
): string {
  const normalizedClinic = clinicId.trim();
  return `ProviderPush|${normalizedClinic}|${requestId}|${expiresAt}|${payloadHash}`;
}

