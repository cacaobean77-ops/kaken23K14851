const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "../artifacts/contracts/PatientAccess.sol/PatientAccess.json");
const dstWeb = path.resolve(__dirname, "../../webapp/src/abi/PatientAccess.json");
const dstWorker = path.resolve(__dirname, "../../worker/abi/PatientAccess.json");

for (const dst of [dstWeb, dstWorker]) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log("ABI copied ->", dst);
}
