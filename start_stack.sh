#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$ROOT_DIR/.run"
mkdir -p "$RUN_DIR"

start_bg () {
  local name="$1"
  local workdir="$2"
  shift 2
  local logfile="$RUN_DIR/${name}.log"
  local pidfile="$RUN_DIR/${name}.pid"

  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo " - ${name} は既に起動中 (pid=$(cat "$pidfile"))"
    return 0
  fi

  echo " - ${name} 起動: $*"
  (cd "$workdir" && nohup "$@" >"$logfile" 2>&1 & echo $! >"$pidfile")
}

# Pre-flight check
if [ ! -d "node_modules" ] && [ ! -d "smart-contracts/node_modules" ]; then
  echo "Error: dependencies not found. Please run ./setup_first.sh"
  exit 1
fi

echo "== 起動開始 =="

echo ""
echo "[1/4] Docker (Orthanc/OHIF) up"
cd "$ROOT_DIR"
docker-compose up -d orthanc_provider orthanc_requester ohif keycloak

echo ""
echo "[2/4] Hardhat node"
# README: npx hardhat node :contentReference[oaicite:6]{index=6}
start_bg "hardhat" "$ROOT_DIR/smart-contracts" npx hardhat node

echo "Waiting for Hardhat to initialize..."
sleep 5

echo "[2.5/4] Deploying Contracts"
(cd "$ROOT_DIR/smart-contracts" && npm run deploy:localhost && npm run export-abi)

echo ""
echo "[3/4] Worker"
# README: npm run dev :contentReference[oaicite:7]{index=7}
start_bg "worker" "$ROOT_DIR/worker" npm run dev

echo ""
echo "[4/4] Webapp"
# README: npm run dev :contentReference[oaicite:8]{index=8}
start_bg "webapp" "$ROOT_DIR/webapp" npm run dev

echo ""
echo "== 起動完了 =="
echo ""
echo "ログ:   $RUN_DIR/*.log"
echo "停止:   ./stop_stack.sh"
echo "状態:   ./status_stack.sh"
echo ""
echo "Webapp: http://localhost:5173"
echo "Worker: http://127.0.0.1:8787 (or https://... if SSL enabled)"
