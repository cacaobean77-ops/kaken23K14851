#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$ROOT_DIR/.run"

stop_pid () {
  local name="$1"
  local pidfile="$RUN_DIR/${name}.pid"

  if [ ! -f "$pidfile" ]; then
    echo " - ${name}: pidfile無し"
    return 0
  fi

  local pid
  pid="$(cat "$pidfile" || true)"
  if [ -n "${pid}" ] && kill -0 "$pid" 2>/dev/null; then
    echo " - ${name} 停止 (pid=${pid})"
    kill "$pid" || true
  else
    echo " - ${name} は既に停止"
  fi
  rm -f "$pidfile"
}

echo "== 停止開始 =="

# Stop known pids
stop_pid "webapp"
stop_pid "worker"
# Worker force cleanup (port 8787)
lsof -ti:8787 | xargs kill -9 2>/dev/null || true
stop_pid "hardhat"

# Fallback: kill any lingering node processes from this project (risky but effective for dev)
# pkill -f "hardhat node" || true


echo " - Docker compose down"
cd "$ROOT_DIR"
docker-compose down

echo "== 停止完了 =="
