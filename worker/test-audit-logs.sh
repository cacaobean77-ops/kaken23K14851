#!/bin/bash
set -e

echo "Getting Admin Token..."
TOKEN=$(curl -s -X POST http://localhost:8080/realms/provider-realm-v2/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=worker-api" \
  -d "username=admin-user" \
  -d "password=password" \
  -d "grant_type=password" | jq -r .access_token)

if [ -z "$TOKEN" ] || [ "$TOKEN" == "null" ]; then
  echo "Failed to get token"
  exit 1
fi

echo "Fetching Audit Logs..."
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8787/audit-logs?limit=5" | jq .
