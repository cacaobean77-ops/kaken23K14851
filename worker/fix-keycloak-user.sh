#!/bin/bash
set -e

# 1. Get Admin Token
echo "Getting Admin Token..."
ADMIN_TOKEN=$(curl -s -X POST http://localhost:8080/realms/master/protocol/openid-connect/token \
  -d "client_id=admin-cli" \
  -d "username=admin" \
  -d "password=admin" \
  -d "grant_type=password" | jq -r .access_token)

if [ -z "$ADMIN_TOKEN" ] || [ "$ADMIN_TOKEN" == "null" ]; then
  echo "Failed to get admin token"
  exit 1
fi

# 2. Get User ID
echo "Getting admin-user ID..."
USER_JSON=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:8080/admin/realms/provider-realm-v2/users?username=admin-user")
USER_ID=$(echo $USER_JSON | jq -r '.[0].id')

if [ -z "$USER_ID" ] || [ "$USER_ID" == "null" ]; then
  echo "Failed to find admin-user"
  exit 1
fi
echo "User ID: $USER_ID"

# 3. Clear Required Actions and Set Email Verified
echo "Updating user..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "emailVerified": true, "requiredActions": [], "enabled": true}' \
  "http://localhost:8080/admin/realms/provider-realm-v2/users/$USER_ID")
echo "Update Status: $HTTP_CODE"

# 4. Reset Password
echo "Resetting password..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"password","value":"password","temporary":false}' \
  "http://localhost:8080/admin/realms/provider-realm-v2/users/$USER_ID/reset-password")
echo "Password Reset Status: $HTTP_CODE"

# 5. Check User State
echo "Checking user state..."
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:8080/admin/realms/provider-realm-v2/users/$USER_ID" | jq .
