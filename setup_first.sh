#!/bin/bash
set -e

echo "=== Setup First: Installing Dependencies & Pulling Images ==="

# 1. Install npm dependencies
for dir in smart-contracts worker webapp; do
  echo "[$dir] Installing dependencies..."
  if [ -f "$dir/package-lock.json" ]; then
    (cd "$dir" && npm ci)
  else
    (cd "$dir" && npm install)
  fi
done

# 1.5 Generate SSL Certificates for Worker
echo "[Worker] Checking SSL certificates..."
WORKER_CERTS_DIR="worker/certs"
mkdir -p "$WORKER_CERTS_DIR"
if [ ! -f "$WORKER_CERTS_DIR/server.key" ] || [ ! -f "$WORKER_CERTS_DIR/server.crt" ]; then
  echo "Generating self-signed certificates in $WORKER_CERTS_DIR..."
  openssl req -x509 -newkey rsa:2048 -keyout "$WORKER_CERTS_DIR/server.key" -out "$WORKER_CERTS_DIR/server.crt" -days 365 -nodes -subj "/CN=localhost"
else
  echo "Certificates already exist."
fi

# 2. Pull Docker images
echo "[Docker] Pulling images..."
docker-compose pull || echo "Warning: docker-compose pull failed, but continuing..."

echo "=== Setup Complete! ==="
echo "You can now run ./start_stack.sh"
