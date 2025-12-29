# Authentication Setup Guide

This project uses Keycloak for authentication. The `docker-compose.yml` includes a Keycloak instance that automatically imports the `provider-realm` with predefined users and roles.

## Quick Start

1. Start the stack:
   ```bash
   docker-compose up -d keycloak
   # Wait for Keycloak to start (check logs: docker logs -f keycloak)
   ```

2. Access Keycloak Admin Console:
   - URL: http://localhost:8080/admin/
   - User: `admin`
   - Pass: `admin`

## Predefined Users (in `provider-realm`)

| Username | Password | Roles | Purpose |
|----------|----------|-------|---------|
| `admin-user` | `password` | `worker.admin`, `worker.read`, `requester.viewer`, `provider.push` | Full access for testing |
| `viewer-user` | `password` | `requester.viewer` | Limited access (Viewer only) |

## Getting a Token (for testing)

You can get a token using the `worker-api` client (Public client, Direct Access Grants enabled):

```bash
# Get token for admin-user
export ACCESS_TOKEN=$(curl -s -X POST http://localhost:8080/realms/provider-realm/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=worker-api" \
  -d "username=admin-user" \
  -d "password=password" \
  -d "grant_type=password" | jq -r .access_token)

echo $ACCESS_TOKEN
```

## Configuring Worker

The Worker needs to verify these tokens. Ensure `worker/provider-agent.config.json` has:

```json
  "auth": {
    "enabled": true,
    "issuer": "http://localhost:8080/realms/provider-realm",
    "audience": "account", 
    "jwks": {
      "keys": [
        // ... JWKs from http://localhost:8080/realms/provider-realm/protocol/openid-connect/certs
        // Note: For now, the Worker config requires static JWKs or a way to fetch them.
        // We will configure the Worker to fetch or use a static set for dev.
      ]
    }
  }
```

> **Note**: The current `worker/auth.ts` implementation expects `jwks.keys` in the config. It does not currently fetch them from a URL automatically (OIDC discovery).
> **Action Required**: You must fetch the JWKS from Keycloak and paste them into the worker config, OR update the worker to fetch them.
> 
> To fetch JWKS:
> ```bash
> curl http://localhost:8080/realms/provider-realm/protocol/openid-connect/certs
> ```
