import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
    const deploymentPath = path.resolve(__dirname, "../deployments/localhost.json");
    if (!fs.existsSync(deploymentPath)) {
        console.error("Deployment file not found. Please run 'npm run deploy:localhost' first.");
        process.exit(1);
    }
    const deployments = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
    const mockAddress = deployments.MockERC20;
    const paAddress = deployments.PatientAccess;

    const [deployer, provider, requester] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const mock = Mock.attach(mockAddress) as any;

    console.log("=== Token Balances (MockERC20) ===");
    console.log(`Token Address: ${mockAddress}`);
    console.log(`Escrow (PatientAccess): ${paAddress}`);
    console.log("------------------------------------------------");

    const decimals = await mock.decimals();
    const symbol = await mock.symbol();

    const format = (val: bigint) => ethers.formatUnits(val, decimals) + " " + symbol;

    const bRequester = await mock.balanceOf(requester.address);
    const bProvider = await mock.balanceOf(provider.address);
    const bEscrow = await mock.balanceOf(paAddress);

    console.log(`Requester (${requester.address}): ${format(bRequester)}`);
    console.log(`Provider  (${provider.address}): ${format(bProvider)}`);
    console.log(`Escrow    (PatientAccess)                     : ${format(bEscrow)}`);

    console.log("------------------------------------------------");
    console.log("Note: When a request is made, tokens move Requester -> Escrow.");
    console.log("      When fulfilled, tokens move Escrow -> Provider.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
