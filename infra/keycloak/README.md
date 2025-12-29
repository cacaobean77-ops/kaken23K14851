# Keycloak ローカルセットアップ (PoC 用)

このディレクトリには、Worker/API の JWT 認証を試すための Keycloak コンテナ環境と初期データが含まれます。Docker Compose を使って 1 コマンドで起動できます。

## 前提条件

- Docker / Docker Compose v2
- ポート `8080` が未使用であること

## 起動手順

```bash
# リポジトリルートから
cd infra
docker compose -f docker-compose.keycloak.yml up -d
```

初回起動時に `keycloak/import/patient-access-realm.json` が自動で読み込まれ、以下が作成されます。

- Realm: `patient-access`
- Clients
  - `worker-api` (confidential) — Worker が `client_credentials` でトークンを取得する想定
  - `webapp` (public) — ブラウザアプリ用（PKCE）
  - `provider-agent` (confidential) — Provider Push Agent がサービスアカウントとして利用
- Realm Roles: `worker.admin`, `worker.read`, `requester.viewer`, `provider.push`
- ユーザー
  - `worker-admin` (`admin`) — Worker 管理API向け（aliases CRUDなど）
  - `requester-viewer` (`viewer`) — `/secure/*` や `/dicom-web-config` を呼ぶ閲覧者
  - `provider-agent` (`provider`) — `/provider-push` を叩くエージェント

Keycloak 管理コンソール: `http://localhost:8080/`
- Adminユーザー: `admin / admin`

## トークンの取得例

### 1) Worker（サービス）用アクセストークン
```bash
curl -s \
  -d "client_id=worker-api" \
  -d "client_secret=worker-api-secret" \
  -d "grant_type=client_credentials" \
  "http://localhost:8080/realms/patient-access/protocol/openid-connect/token"
```
レスポンスJSONの `access_token` を Worker API へ Bearer ヘッダで付与してください。

### 2) Provider Push Agent 用トークン
```bash
curl -s \
  -d "client_id=provider-agent" \
  -d "client_secret=provider-agent-secret" \
  -d "grant_type=client_credentials" \
  "http://localhost:8080/realms/patient-access/protocol/openid-connect/token"
```
取得した `access_token` を `worker/provider-agent.config.json` の `workerAuth.token` に設定します（もしくは自動取得する処理へ組み込む）。

### 3) ユーザー（Requester Viewer）の例
```bash
curl -s \
  -d "client_id=webapp" \
  -d "grant_type=password" \
  -d "username=requester-viewer" \
  -d "password=viewer" \
  "http://localhost:8080/realms/patient-access/protocol/openid-connect/token"
```
※ 実運用では PKCE / ブラウザリダイレクトを利用してください。

## 後片付け

```bash
cd infra
docker compose -f docker-compose.keycloak.yml down -v
```

これでコンテナ／ボリュームが削除されます。

## Worker 側設定例

`worker/config.json` の `auth` を以下のように更新します。

```json
"auth": {
  "enabled": true,
  "issuer": "http://localhost:8080/realms/patient-access",
  "audience": "worker-api",
  "jwks": {
    "keys": [
      {
        "kid": "worker-dev",
        "kty": "RSA",
        "alg": "RS256",
        "use": "sig",
        "n": "<infra/keycloak/exported-public-key-n>",
        "e": "AQAB"
      }
    ]
  }
}
```

※ JWKS の `n` などは Keycloak 管理コンソールの `Realm Settings > Keys > Active` から RSA 公開鍵を JWK 形式でエクスポートしてください。

`signers` には Provider 側の署名サービスを登録し、Worker が `markFulfilled` 実行を外部委譲できるようにします。

## 注意

- この構成はローカル開発専用であり、パスワード・クライアントシークレットはサンプルです。本番環境では必ず強固なシークレットと TLS を設定してください。
- `KC_HOSTNAME=localhost` のため、他ホストからアクセスする場合は docker-compose と Keycloak 設定を変更する必要があります。

