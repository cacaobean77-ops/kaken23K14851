# 患者単位DICOMアクセス PoC — 拡張ハンドオフ & 仕様書（v0.2）

最終更新: 2025-09-16（JST）  
目的: この文書だけで新メンバー/新しいChatGPTスレッドに合流できるよう、**運用手順 / 仕様 / 設計 / トラブルシュート / 今後の計画**を包括します。

---

## 0. TL;DR（最短デモ）
1. **Hardhat**（別ターミナル）
   ```bash
   cd smart-contracts
   npx hardhat node --port 8545
   npm run deploy:localhost
   npm run export-abi
   # → deployments/localhost.json を参照
   ```
2. **Orthanc & OHIF**（Docker）
   ```bash
   docker-compose up -d orthanc_provider orthanc_requester ohif
   curl -i http://localhost:8043/system     # 200（Requester認証OFF）
   ```
3. **Web UI**
   ```bash
   cd webapp
   echo "VITE_CONTRACT=<PatientAccessアドレス>" > .env.local
   npm i && npm run dev   # http://localhost:5173/
   ```
4. **Worker**
   ```bash
   cd worker
   npm i && npm run dev
   # ログ: PatientApproved -> QIDO found -> copied -> markFulfilled confirmed
   ```
5. **E2E**
   - Requester UIで申請 → 患者UI（MetaMask患者アカウント）で承認  
   - Workerが Provider→Requester へコピー → 清算 → OHIF (http://localhost:3000/) で閲覧

---

## 1. 全体像（アーキテクチャ）

```
[Requester Web UI]   [Patient Web UI]      [Worker]
       |                    |                 |
       | tx:createBatch     | tx:patientApprove
       | ------------------> | ----------------> [Hardhat RPC 8545]
       |                    |                 |   └─ PatientApproved イベント
       |                    |                 |
       |                    |                 v
       |                    |           [Provider Orthanc 8042] --(QIDO/WADO/REST)--> [Requester Orthanc 8043]
       |                    |                 |
       |                    |                 ---> tx:markFulfilled(manifestHash) ---> [PatientAccess]
       |                    |                                                     |
       v                    v                                                     v
   OHIF(3000) ←―――――――――――――――――――― DICOMweb(8043)（Requester） ―――――――――――――――――――→ 完了
```

- **PatientAccessコントラクト**: 申請作成・患者承認・履行清算・イベント発火。  
- **Worker**: `PatientApproved` 検知→コピー→`markFulfilled`。  
- **Orthanc**: Provider（在庫）/ Requester（取り寄せ）。  
- **OHIF**: Requester の DICOMWeb を参照し閲覧。

---

## 2. リポジトリ構造（確定版）

```
blockchain_project2/
├─ smart-contracts/
│  ├─ contracts/PatientAccess.sol
│  ├─ scripts/deploy.ts
│  ├─ scripts/export-abi.js
│  ├─ deployments/localhost.json              # 生成物: アドレス
│  ├─ hardhat.config.ts
│  ├─ artifacts/                              # 生成物
│  └─ typechain-types/                        # 生成物
├─ webapp/
│  ├─ src/
│  │  ├─ App.tsx
│  │  ├─ main.tsx
│  │  ├─ components/RequesterDashboard.tsx
│  │  ├─ components/PatientApprovals.tsx
│  │  ├─ hooks/usePatientAccess.ts
│  │  └─ abi/PatientAccess.json               # 生成物: ABI（export-abi）
│  ├─ index.html
│  ├─ package.json / tsconfig.json / vite.config.ts
│  └─ .env.local                              # VITE_CONTRACT=...
├─ worker/
│  ├─ index.ts                                # Worker本体
│  ├─ config.json                             # Worker設定
│  ├─ abi/PatientAccess.json                  # 生成物: ABI
│  ├─ package.json / tsconfig.json
├─ docker-compose.yml                         # Orthanc×2, OHIF
├─ orthanc/requester.json                     # Requester 認証OFF 設定
├─ ohif/app-config.js                         # 認証ONで使う場合の dataSources 設定
└─ README.md / 仕様書（本ファイル）
```

---

## 3. スマートコントラクト詳細

### 3.1 データ構造（抜粋）
- `Clinic { registered, clinicId, payout, operator }`
- `Price  { token, readPrice, copyPrice, set }`
- `AccessRequest { id, patient, providerClinicKey, requesterClinicKey, mode, token, price, status, manifestHash }`
- `AccessBatch  { batchId, patient, requesterClinicKey, mode, childIds[], totalPrice, token, exists }`

> `clinicKey = keccak256(utf8(clinicId))` で紐付け。`Mode{READ=0, COPY=1}` / `Status{REQUESTED=0, PATIENT_APPROVED=1, FULFILLED=2,...}`。

### 3.2 主要関数（想定 I/F）
- `createAccessBatch(address patient, string requesterClinicId, string[] providers, uint8 mode)`  
  - 子リクエスト群を生成し、`AccessBatchCreated(batchId, childIds[])` を emit。
- `patientApprove(uint256 id)`  
  - 患者（msg.sender）が承認。`PatientApproved(id)` emit。
- `markFulfilled(uint256 id, bytes32 manifestHash)`  
  - Provider の operator が履行と清算を実行。`Fulfilled(id)` emit。

### 3.3 主要イベント（PoCで利用）
- `AccessBatchCreated(uint256 batchId, uint256[] childIds)`  
- `PatientApproved(uint256 id)`  
- `Fulfilled(uint256 id, bytes32 manifestHash)`

### 3.4 状態遷移
```
REQUESTED(0) --patientApprove--> PATIENT_APPROVED(1) --markFulfilled--> FULFILLED(2)
```

### 3.5 清算（ERC20想定）
- Provider 公表価格 `Price[token]` を参照（READ/COPY）。
- Requester が `approve(PatientAccess, sumPrice)` 済みであること。
- `markFulfilled` 内で `transferFrom(Requester → Provider.payout)` を実施（PoC）。

> UIで allowance 残高の可視化＆approve ボタンの提供を今後追加。

---

## 4. Worker 設計

### 4.1 アルゴリズム（WADO→RESTフォールバック）
擬似コード：
```ts
on PatientApproved(id):
  const r = contract.reqs(id)
  const providerId = resolveProviderIdByKey(r.providerClinicKey)
  const patientId  = aliasResolver(patientAddress)

  // 1) QIDO
  let instances = qido.instances({ PatientID: patientId })
  // 2) 取得ループ
  const uids: string[] = []
  for each (study, series, sop) in instances:
    try {
      // 2-a) WADO (application/dicom)
      const dcm = wado.get(study, series, sop, { Accept: application/dicom })
      requester.upload(/instances, dcm)
      uids.push(sop)
    } catch (e) {
      // 2-b) REST fallback
      const oid = provider.lookup(sop)        // POST /tools/lookup (raw SOP)
      const dcm = provider.getFile(oid)       // GET  /instances/{id}/file
      requester.upload(/instances, dcm)
      uids.push(sop)
    }
  // 3) manifestHash
  const manifestHash = keccak256(sort(uids).join("|"))
  // 4) 清算
  contract.markFulfilled(id, manifestHash)
```

### 4.2 設定 `worker/config.json` スキーマ（簡易）
```json
{
  "rpcUrl": "http://127.0.0.1:8545",
  "chainId": 31337,
  "contractAddress": "0x...",
  "clinics": {
    "PROV-001": {
      "role": "provider",
      "operatorPrivateKey": "0x...",
      "priceToken": "0x..."
    }
  },
  "providers": {
    "PROV-001": {
      "qido": { "baseUrl": "http://localhost:8042", "auth": { "type": "basic", "username": "orthanc", "password": "orthanc" }, "issuer": "PROV-001" },
      "wado": { "baseUrl": "http://localhost:8042", "auth": { "type": "basic", "username": "orthanc", "password": "orthanc" } }
    }
  },
  "requester": { "orthanc": { "baseUrl": "http://localhost:8043" } },
  "aliasResolver": { "type": "map", "map": { "<Wallet>": "<PatientID>" } },
  "copy": { "mode": "orthanc", "batchSize": 64 },
  "logLevel": "info"
}
```

### 4.3 ログ & ガード
- 重要箇所は `try/catch`。HTTP失敗時は `url/status/response-snippet` を出力。
- ポーリング間隔は 1.5s 目安、`processed` セットで重複防止。
- 例外でもプロセスを落とさず継続する（指数バックオフ）。

### 4.4 ゲートウェイ API / アクセス制御
- Worker は `http://${api.host}:${api.port}`（デフォルト: `127.0.0.1:8787`）で HTTP API を公開。
  - `GET /aliases` / `PUT /aliases` / `DELETE /aliases/:address` — ウォレット↔患者IDのマッピング管理。
  - `GET /secure/*?requestId=` — Orthanc へのプロキシ。requestId が `PATIENT_APPROVED` 以上、かつ Worker が管理する Requester Clinic であることを検証。
  - Proxy 時は Basic 認証ヘッダをそのまま転送し、`Content-Length`/`Transfer-Encoding` は削除。
- `/secure/*` へのアクセスは `worker/gateway-audit.jsonl` に JSON Lines 形式で記録（timestamp / method / path / requestId / patientId / status / upstreamStatus / error）。
  - `config.json` の `audit.file` で保存先パスを上書き可能。

### 4.5 CopyEventStore（観測性）
- `CopyEventStore` が直近のコピー履歴（成功/失敗数、失敗 SOP、エラー）を保持。
- `GET /copy-events` で JSON を返却し、Requester UI が 7 秒間隔でポーリング。
- 失敗があれば UI 上で警告を表示し、`failures[0..2]` をリスト表示。ローカルログと合わせて原因が追跡しやすい構成。
- 将来的には Slack / PagerDuty 等への連携を、この API を基点に追加予定。
- `GET /dicom-web-config` を提供し、OHIF の `viewer/dicomwebproxy` ルートに `servers.dicomWeb` 設定を供給（Basic 認証込み）。

---

## 5. DICOM / Orthanc / OHIF

### 5.1 Docker（実運用の要点）
- **Provider (8042)**: 認証ON、`DICOM_WEB_PLUGIN_ENABLED=true`、`ORTHANC__DICOM_WEB__ROOT=/dicom-web`。
- **Requester (8043)**: 開発時は **認証OFF**（`orthanc/requester.json` をマウント）。
- **OHIF (3000)**:  
  - 認証OFFなら `?url=http://localhost:8043/dicom-web` でOK。  
  - 認証ONなら `ohif/app-config.js` の **dataSources** に DICOMweb を定義（必要に応じ Authorization を付与）。

### 5.2 よく使うREST/QIDO/WADO
- **QIDO**  
  `GET /dicom-web/instances?PatientID=...&includefield=00080018,0020000D,0020000E&limit=5000`
- **WADO（生DICOM）**  
  `GET /dicom-web/studies/{Study}/series/{Series}/instances/{SOP}` with `Accept: application/dicom`
- **REST（フォールバック）**  
  `POST /tools/lookup` (body = SOPInstanceUID 生文字列) → `GET /instances/{OID}/file`
- **UPLOAD**  
  `POST /instances` （Content-Type: application/dicom）

### 5.3 DCMTK（ProviderへC-STORE）
```bash
storescu -aec ORTHANC 127.0.0.1 4242 -v +sd +r /path/to/folder
# +sd +r を忘れると再帰ディレクトリ送信にならない
```

### 5.4 OHIF 設定（認証ON時）
`ohif/app-config.js` の **最小 dataSources 例**：
```js
(function () {
  window.config = {
    routerBasename: '/',
    showStudyList: true,
    dataSources: [{
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'dicomweb',
      configuration: {
        friendlyName: 'Requester (Orthanc 8043)',
        qidoRoot: 'http://localhost:8043/dicom-web',
        wadoRoot: 'http://localhost:8043/dicom-web',
        wadoUriRoot: 'http://localhost:8043/dicom-web',
        qidoSupportsIncludeField: true,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true
        // 認証を付ける場合は Nginx 側で Basic を付与 or プロキシを推奨
      },
    }],
    defaultDataSourceName: 'dicomweb',
  };
})();
```

---

## 6. Web UI

### 6.1 Requester Dashboard（主なI/F）
- 入力: 患者アドレス、Requester ClinicID、Provider IDs（複数）、READ/COPY
- アクション: `createAccessBatch` → トランザクション receipt の `AccessBatchCreated` / `AccessRequested` から **reqId** を抽出してUI表示
- バリデーション: MetaMask が **Requesterのoperator** であること

### 6.2 Patient Portal
- ログイン=患者ウォレット
- `reqs` から `REQUESTED` を列挙 → `patientApprove(reqId)`

### 6.3 共通
- `.env.local` に `VITE_CONTRACT`。Vite は Node 20.19+ 推奨。

---

## 7. トラブルシュート（観測事象 → 対処）

| 症状/メッセージ | 原因 | 対処 |
|---|---|---|
| `NOT_REQUESTER_OPERATOR` | MetaMask が Requester operator ではない | アカウントを切替（Hardhat 既定アカウントの 3番目等） |
| `NOT_PATIENT` | 患者承認を患者以外が実行 | MetaMask を患者アカウントに |
| `EMPTY_PROVIDERS` | Provider 配列が空 | UI入力 or 引数を確認 |
| ENS unsupported | 31337 に ENS なし | `resolveName` 不使用。`getAddress` 等を使用 |
| QIDO 404 | DICOMweb 未有効/パス誤り | `DICOM_WEB_PLUGIN_ENABLED=true`, `ORTHANC__DICOM_WEB__...` を確認 |
| WADO → `Bad file format` | MIME/JSON を生DICOMと誤解 | `Accept: application/dicom` 付与 or REST フォールバック |
| OHIF Study 0件 | 認証/設定/キャッシュ | 認証OFFで ?url を使う or dataSources 定義、強制リロード |
| ポート衝突 | 既存コンテナが占有 | `docker ps --filter publish=PORT` で突き止め停止 |

---

## 8. セキュリティ / 個人情報

- **同意**: 患者の `patientApprove` をオンチェーンに記録（誰がいつ承認）。
- **ID マッピング**: PoCでは `aliasResolver.map`。本実装では `clinicId + 氏名 + DOB` のハッシュ等を検討（衝突/再識別リスク評価）。
- **最小権限**: `operator` ロールのキーをホットウォレット分離、署名用途のみ。
- **監査**: `manifestHash` によりコピー対象UIDの追跡可能性を担保（オフチェーン一覧と照合）。
- **CORS/認証**: 本番は Requester も認証ON + リバースプロキシでヘッダ管理。

---

## 9. 受け入れ条件（DoD）

- [ ] Requester UI で申請 → **reqId 表示**  
- [ ] 患者UIで承認 → **コントラクト status=1**  
- [ ] Worker が **QIDO>=1** を検出し、Requester へ **/instances POST >=1**  
- [ ] `markFulfilled` が成功（status=2、イベント受信）  
- [ ] OHIF で **Study 一覧>0**、画像閲覧可能

---

## 10. 今後の計画（タスク分解）

### M1: 安定化
- [ ] Worker: RESTフォールバック実装 + リトライ/バックオフ
- [ ] Worker: 部分成功時の `manifestHash` 規約（例: 成功分のみ）
- [ ] UI: 子req/バッチの状態可視化、Polling 更新
- [ ] UI: Allowance/Price UI
- [ ] CI: `npm run test` / `hardhat test` / `eslint`

### M2: ID/セキュリティ
- [ ] `patientAlias` のUI管理（ウォレット↔IDの登録/削除）
- [ ] Operator 権限操作のマルチシグ化/権限境界
- [ ] 監査ログの集計ビュー（オフチェーンDB）

### M3: 本番準備
- [ ] L2テストネット対応（部署用 RPC）
- [ ] 本物のPACS/IdP連携（OIDC）
- [ ] トークン/価格/返金ポリシー・期限・失効処理

---

## 11. 参考レシピ（コマンド集）

```bash
# Provider: QIDO 1件
curl -u orthanc:orthanc "http://localhost:8042/dicom-web/instances?limit=1"

# Provider: WADO → 生DICOM
curl -u orthanc:orthanc "http://localhost:8042/dicom-web/studies/$STUDY/series/$SERIES/instances/$SOP" \
  -H "Accept: application/dicom" -o /tmp/test.dcm

# Provider: REST フォールバック
curl -u orthanc:orthanc -X POST http://localhost:8042/tools/lookup --data-raw "$SOP"
curl -u orthanc:orthanc http://localhost:8042/instances/$OID/file -o /tmp/test_raw.dcm

# Requester: アップロード
curl -X POST http://localhost:8043/instances -H "Content-Type: application/dicom" \
  --data-binary @/tmp/test_raw.dcm -i

# Hardhat Console: 状態確認
npx hardhat console --network localhost
> const d=require('./deployments/localhost.json')
> const pa=await ethers.getContractAt('PatientAccess', d.PatientAccess)
> (await pa.reqs(REQ_ID)).status   // 2n=FULFILLED
```

---

## 12. 付録

### 12.1 `docker-compose.yml`（要点）
```yaml
services:
  orthanc_provider:
    image: orthancteam/orthanc:latest
    container_name: orthanc_provider
    ports: ["8042:8042", "4242:4242"]
    environment:
      ORTHANC__AuthenticationEnabled: "true"
      DICOM_WEB_PLUGIN_ENABLED: "true"
      ORTHANC__DICOM_WEB__ENABLE: "true"
      ORTHANC__DICOM_WEB__ROOT: /dicom-web
    volumes:
      - ./data/provider:/var/lib/orthanc/db

  orthanc_requester:
    image: orthancteam/orthanc:latest
    container_name: orthanc_requester
    ports: ["8043:8042"]
    volumes:
      - ./orthanc/requester.json:/etc/orthanc/orthanc.json:ro
      - ./data/requester:/var/lib/orthanc/db

  ohif:
    image: ohif/viewer:latest
    container_name: ohif_viewer
    ports: ["3000:80"]
```

### 12.2 `orthanc/requester.json`
```json
{
  "Name": "Requester",
  "AuthenticationEnabled": false,
  "DicomWeb": { "Enable": true, "Root": "/dicom-web" },
  "HttpHeaders": {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  }
}
```

### 12.3 `ohif/app-config.js`（dataSources版）
```js
(function () {
  window.config = {
    routerBasename: '/',
    showStudyList: true,
    dataSources: [{
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'dicomweb',
      configuration: {
        friendlyName: 'Requester (Orthanc 8043)',
        qidoRoot: 'http://localhost:8043/dicom-web',
        wadoRoot: 'http://localhost:8043/dicom-web',
        wadoUriRoot: 'http://localhost:8043/dicom-web',
        qidoSupportsIncludeField: true,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true
      },
    }],
    defaultDataSourceName: 'dicomweb',
  };
})();
```

---

このファイルを新しいメンバーに配布/新チャットで貼り付ければ、すぐ続きから共同開発できます。
