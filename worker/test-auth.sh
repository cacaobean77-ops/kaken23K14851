#!/bin/bash
set -e

echo "--- 1. Testing Unauthenticated Access (Expect 401) ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/copy-events)
echo "Status: $STATUS"
if [ "$STATUS" != "401" ]; then
  echo "FAIL: Expected 401, got $STATUS"
  exit 1
fi
echo "PASS: Unauthenticated access blocked"

echo "--- 2. Getting Token from Keycloak ---"
TOKEN=$(curl -s -X POST http://localhost:8080/realms/provider-realm-v2/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=worker-api" \
  -d "username=admin-user" \
  -d "password=password" \
  -d "grant_type=password" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "FAIL: Could not get token"
  exit 1
fi

# Decode Token
PAYLOAD=$(echo "$TOKEN" | cut -d. -f2)
echo "Payload (Raw): $PAYLOAD"
# Add padding if needed check via node for simplicity
node -e 'console.log(Buffer.from(process.argv[1], "base64url").toString("utf8"))' "$PAYLOAD" | jq .

echo "--- 3. Testing Authenticated Access (Expect 200) ---"
RESPONSE_BODY=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/copy-events)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" http://localhost:8787/copy-events)
echo "Status: $STATUS"
echo "Body: $RESPONSE_BODY"

if [ "$STATUS" != "200" ]; then
  echo "FAIL: Expected 200, got $STATUS"
  exit 1
fi
echo "PASS: Authenticated access allowed"
