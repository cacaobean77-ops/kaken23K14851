import { keccak256, toUtf8Bytes } from "ethers";

export function calcManifestHash(uids: string[]): string {
  const sorted = [...uids].sort();
  const joined = sorted.join("\n");
  return keccak256(toUtf8Bytes(joined));
}
