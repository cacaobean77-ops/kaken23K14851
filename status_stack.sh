#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$ROOT_DIR/.run"

check () {
  local name="$1"
  local pidfile="$RUN_DIR/${name}.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "${name}: RUNNING (pid=$(cat "$pidfile"))"
  else
    echo "${name}: STOPPED"
  fi
}

check hardhat
check worker
check webapp

echo ""
echo ""
echo "Docker Containers:"
cd "$ROOT_DIR"
docker-compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
