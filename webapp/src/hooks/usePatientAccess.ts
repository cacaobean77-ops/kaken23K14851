// webapp/src/hooks/usePatientAccess.ts
import { useEffect, useState } from "react";
import { ethers } from "ethers";
import abi from "../abi/PatientAccess.json";

export type ContractContext = {
  contract: ethers.Contract | null;
  signer: ethers.Signer | null;
  address: string | null;
  provider: ethers.BrowserProvider | null;
  chainId: number | null;
};

const emptyContext: ContractContext = {
  contract: null,
  signer: null,
  address: null,
  provider: null,
  chainId: null,
};

export function useContract(addr: string): ContractContext {
  const [ctx, setCtx] = useState<ContractContext>(emptyContext);

  useEffect(() => {
    let cancelled = false;

    const connect = async () => {
      const anyWin = window as any;
      if (!anyWin.ethereum || !addr) {
        setCtx(emptyContext);
        return;
      }

      try {
        const provider = new ethers.BrowserProvider(anyWin.ethereum);
        await provider.send("eth_requestAccounts", []);
        const signer = await provider.getSigner();
        const [address, network] = await Promise.all([
          signer.getAddress(),
          provider.getNetwork(),
        ]);
        const contract = new ethers.Contract(addr, (abi as any).abi, signer);

        if (!cancelled) {
          setCtx({
            contract,
            signer,
            address,
            provider,
            chainId: Number(network.chainId),
          });
        }
      } catch (err) {
        console.error("useContract: failed to initialise", err);
        if (!cancelled) setCtx(emptyContext);
      }
    };

    setCtx(emptyContext);
    connect();

    return () => {
      cancelled = true;
    };
  }, [addr]);

  return ctx;
}
