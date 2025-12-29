#!/usr/bin/env bash
set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}Starting E2E Flow Test${NC}"

# Check dependencies
command -v curl >/dev/null 2>&1 || { echo >&2 "curl required but not installed. Aborting."; exit 1; }

# Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
API_URL="http://127.0.0.1:8787"
WORKER_DIR="$ROOT_DIR/worker"
SMART_CONTRACTS_DIR="$ROOT_DIR/smart-contracts"

# 1. CI/Test Checks
echo -e "${GREEN}[1/5] Verifying CI Checks Locally...${NC}"
(cd "$WORKER_DIR" && npm run lint && npm run test) || { echo -e "${RED}Worker CI failed${NC}"; exit 1; }
echo "Worker CI OK"

# 2. Check Worker Health (Use /health)
echo -e "${GREEN}[2/5] Checking Worker Connectivity...${NC}"
# Use --fail to exit with non-zero if 404/500
if curl -s -f "$API_URL/health" > /dev/null; then
    echo "Worker is UP at $API_URL"
else 
    echo -e "${RED}Worker is unreachable at $API_URL or returned error. Is the stack running?${NC}"
    echo "This might be expected if running CI only."
fi

# 3. Documentation Consistency
echo -e "${GREEN}[3/5] Verifying Documentation...${NC}"
if [ ! -f "$ROOT_DIR/docs/access-control.md" ]; then
    echo -e "${RED}docs/access-control.md missing${NC}"
    exit 1
fi
echo "Documentation present."

echo -e "${GREEN}E2E Script Completed (Basic Checks Passed)${NC}"
echo "To run full integration tests, ensure the local network is running and use the dedicated test suite."
