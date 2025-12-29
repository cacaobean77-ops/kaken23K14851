import { ethers } from "ethers";

export function clinicKey(clinicId: string): string | null {
  const trimmed = clinicId.trim();
  if (!trimmed) return null;
  return ethers.keccak256(ethers.toUtf8Bytes(trimmed)).toLowerCase();
}

export function checksum(address: string): string {
  try {
    return ethers.getAddress(address);
  } catch {
    return address;
  }
}

export function canonical(address: string): string {
  try {
    return ethers.getAddress(address).toLowerCase();
  } catch {
    return address.toLowerCase();
  }
}
