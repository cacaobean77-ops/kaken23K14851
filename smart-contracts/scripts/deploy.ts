// smart-contracts/scripts/deploy.ts
import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

function extractPrivateKey(signer: any): string | undefined {
  if (!signer) return undefined;
  if (typeof signer.privateKey === "string") return signer.privateKey;
  if (typeof signer._signingKey === "function") {
    try {
      const key = signer._signingKey();
      if (key && typeof key.privateKey === "string") return key.privateKey;
    } catch (_) {
      // ignore
    }
  }
  return undefined;
}

async function main() {
  const [deployer, providerOp, requesterOp] = await ethers.getSigners();

  // 1) MockERC20
  const Mock = await ethers.getContractFactory("MockERC20");
  const total = ethers.parseEther("1000000");
  const mock = await Mock.connect(deployer).deploy(total);
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();
  console.log("MockERC20:", mockAddr);

  // 2) PatientAccess
  const PA = await ethers.getContractFactory("PatientAccess");
  const pa = await PA.connect(deployer).deploy();
  await pa.waitForDeployment();
  const paAddr = await pa.getAddress();
  console.log("PatientAccess:", paAddr);

  // 3) クリニック登録（例）
  await (await pa.connect(providerOp).registerClinic("PROV-001", providerOp.address, providerOp.address)).wait();
  await (await pa.connect(requesterOp).registerClinic("REQ-001", requesterOp.address, requesterOp.address)).wait();

  // 4) 価格設定（READ/COPY 単位は TST）
  await (await pa.connect(providerOp).setPrice("PROV-001", mockAddr,
    ethers.parseEther("10"), // READ
    ethers.parseEther("20")  // COPY
  )).wait();

  // 5) requester にトークン配布
  const requesterInitial = ethers.parseEther("1000");
  await (await mock.connect(deployer).transfer(requesterOp.address, requesterInitial)).wait();

  // 6) requester → PatientAccess への事前 allowance を確保
  await (
    await mock
      .connect(requesterOp)
      .approve(paAddr, ethers.MaxUint256)
  ).wait();

  // 7) 書き出し（任意：アドレス管理 & webapp へ反映）
  const out = { network: "localhost", MockERC20: mockAddr, PatientAccess: paAddr };
  fs.mkdirSync(path.resolve(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, "../deployments/localhost.json"), JSON.stringify(out, null, 2));

  const workerConfigPath = path.resolve(__dirname, "../../worker/config.json");
  try {
    const raw = fs.readFileSync(workerConfigPath, "utf-8");
    const config = JSON.parse(raw);

    config.clinics = config.clinics ?? {};

    const providerPrivateKey = extractPrivateKey(providerOp);
    const requesterPrivateKey = extractPrivateKey(requesterOp);

    config.clinics["PROV-001"] = {
      ...(config.clinics["PROV-001"] ?? {}),
      role: "provider",
      ...(providerPrivateKey ? { operatorPrivateKey: providerPrivateKey } : {}),
      priceToken: mockAddr,
    };

    config.clinics["REQ-001"] = {
      ...(config.clinics["REQ-001"] ?? {}),
      role: "requester",
      ...(requesterPrivateKey ? { operatorPrivateKey: requesterPrivateKey } : {}),
    };

    fs.writeFileSync(workerConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    console.log("Updated", workerConfigPath);
  } catch (err) {
    console.warn("Failed to update worker/config.json:", err);
  }

  const envPath = path.resolve(__dirname, "../../webapp/.env.local");
  let envEntries: Record<string, string> = {};
  try {
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx);
        const value = trimmed.slice(idx + 1);
        envEntries[key] = value;
      }
    }
  } catch (err) {
    console.warn("Failed to read existing .env.local:", err);
  }

  envEntries.VITE_CONTRACT = paAddr;
  envEntries.VITE_ORTHANC_BASE_RQ = envEntries.VITE_ORTHANC_BASE_RQ ?? "http://localhost:8787/secure";
  envEntries.VITE_RQ_DICOMWEB = envEntries.VITE_RQ_DICOMWEB ?? "http://localhost:8787/secure/{requestId}/dicom-web";
  envEntries.VITE_WORKER_API = envEntries.VITE_WORKER_API ?? "http://localhost:8787";
  envEntries.VITE_OHIF_URL = envEntries.VITE_OHIF_URL ?? "http://localhost:3000";
  envEntries.VITE_ORTHANC_USER = envEntries.VITE_ORTHANC_USER ?? "orthanc";
  envEntries.VITE_ORTHANC_PASS = envEntries.VITE_ORTHANC_PASS ?? "orthanc";

  const envContent = Object.entries(envEntries)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";

  fs.writeFileSync(envPath, envContent, "utf-8");
  console.log("Updated", envPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
