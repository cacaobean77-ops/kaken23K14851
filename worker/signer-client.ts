import axios, { AxiosRequestConfig } from "axios";
import { Wallet, Contract, JsonRpcProvider, Provider } from "ethers";
import abi from "./abi/PatientAccess.json" with { type: "json" };

export type SignerHttpAuth =
  | { type: "basic"; username: string; password: string }
  | { type: "bearer"; token: string };

export type SignerHttpConfig = {
  type: "http";
  endpoint: string;
  auth?: SignerHttpAuth;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export type SignerMockConfig = {
  type: "mock";
  txHashPrefix?: string;
};

export type SignerPrivateKeyConfig = {
  type: "privateKey";
  privateKey: string;
};

export type SignerConfig = SignerHttpConfig | SignerMockConfig | SignerPrivateKeyConfig;

export type MarkFulfilledPayload = {
  requestId: number;
  providerId: string;
  manifestHash: string;
  patientAddress: string;
  patientId: string;
  success: number;
  failed: number;
};

export type MarkFulfilledResult = {
  txHash?: string;
  message?: string;
};

export class SignerClient {
  constructor(
    private readonly configs: Record<string, SignerConfig>,
    private readonly provider?: Provider,
    private readonly contractAddress?: string
  ) { }

  hasSigner(clinicId: string): boolean {
    return !!this.configs?.[clinicId];
  }

  async markFulfilled(clinicId: string, payload: MarkFulfilledPayload): Promise<MarkFulfilledResult> {
    const cfg = this.configs?.[clinicId];
    if (!cfg) {
      throw new Error(`signer config not found for clinic ${clinicId}`);
    }

    if (cfg.type === "mock") {
      const suffix = Date.now().toString(16);
      return { txHash: `${cfg.txHashPrefix ?? "0xmock"}${suffix}` };
    }

    if (cfg.type === "privateKey") {
      if (!this.provider || !this.contractAddress) {
        throw new Error("SignerClient: provider and contractAddress are required for privateKey signer");
      }
      const wallet = new Wallet(cfg.privateKey, this.provider);
      const contract = new Contract(this.contractAddress, abi.abi, wallet);

      // markFulfilled(uint256 id, bytes32 manifestHash)
      const tx = await contract.markFulfilled(payload.requestId, payload.manifestHash);
      // We don't wait for confirmation here, just return the hash, similar to HTTP signer
      return { txHash: tx.hash };
    }

    const requestConfig: AxiosRequestConfig = {
      url: cfg.endpoint,
      method: "POST",
      data: payload,
      timeout: cfg.timeoutMs ?? 45_000,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.headers ?? {}),
      },
    };

    if (cfg.auth) {
      if (cfg.auth.type === "basic") {
        requestConfig.auth = {
          username: cfg.auth.username,
          password: cfg.auth.password,
        };
      } else if (cfg.auth.type === "bearer") {
        requestConfig.headers = {
          ...(requestConfig.headers ?? {}),
          Authorization: `Bearer ${cfg.auth.token}`,
        };
      }
    }

    const res = await axios.request(requestConfig);
    if (typeof res.data === "object" && res.data !== null) {
      return {
        txHash: res.data.txHash,
        message: res.data.message,
      };
    }
    return { txHash: undefined, message: undefined };
  }
}

