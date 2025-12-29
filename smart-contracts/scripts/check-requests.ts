import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
    const deploymentPath = path.resolve(__dirname, "../deployments/localhost.json");
    const deployments = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
    const paAddress = deployments.PatientAccess;

    const PatientAccess = await ethers.getContractFactory("PatientAccess");
    const pa = PatientAccess.attach(paAddress) as any;

    console.log("=== Access Requests Status ===");
    const nextId = await pa.nextReqId();
    console.log(`Total Requests: ${nextId}`);

    const STATUS = ["REQUESTED", "PATIENT_APPROVED", "FULFILLED", "EXPIRED", "CANCELED"];

    for (let i = 1; i <= nextId; i++) {
        const r = await pa.reqs(i);
        const statusStr = STATUS[Number(r.status)] || "UNKNOWN";
        console.log(`ID ${i}: Status=${statusStr} (${r.status}), Price=${ethers.formatEther(r.price)}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
