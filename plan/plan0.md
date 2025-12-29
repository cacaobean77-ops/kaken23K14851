# 患者単位DICOMアクセス PoC 仕様書（v0.1）

最終更新: 2025-09-16（JST）

---

## 1. 概要
本PoCは、**患者単位**で他院DICOMサーバ上の画像にアクセス・閲覧・コピーする権利を、スマートコントラクトで合意・清算できることを検証するものです。患者の同意（オンチェーン）をトリガに、ワーカーが**Provider Orthanc → Requester Orthanc**へDICOMコピーを実行し、完了後に**markFulfilled**で報酬を清算します。UIはRequester/Patient向けのWeb（React）を実装しています。

---

## 2. システム構成（俯瞰）
- **ブロックチェーン**: Hardhat ローカル（chainId=31337）。
  - コントラクト: `PatientAccess`（患者承認 & 履行清算）
  - 支払トークン: `MockERC20`（PoC用）
- **ワーカー（Node/TypeScript）**: `PatientApproved` イベントを監視し、QIDO/WADO（またはRESTフォールバック）でコピー→`markFulfilled`。
- **DICOM**: Orthanc ×2
  - Provider: 画像の在庫側（認証ON/開発時はONでも可）
  - Requester: 取り寄せ先（開発時は認証OFFでOHIFから閲覧）
- **ビューア**: OHIF（Orthanc Requester の DICOMweb を参照）
- **Web UI**: Requesterダッシュボード / 患者ポータル（MetaMask連携）

---

## 3. ファイル構成（トップ階層）
```
blockchain_project2/
├─ smart-contracts/
│  ├─ contracts/PatientAccess.sol
│  ├─ scripts/deploy.ts
│  ├─ scripts/export-abi.js
│  ├─ deployments/localhost.json              # 生成物（デプロイ結果）
│  ├─ hardhat.config.ts
│  ├─ test/patientAccess.spec.ts (雛形)
│  ├─ artifacts/                             # 生成物（Solc成果物）
│  └─ typechain-types/                       # 生成物（型）
├─ webapp/
│  ├─ src/
│  │  ├─ App.tsx
│  │  ├─ main.tsx
│  │  ├─ components/
│  │  │  ├─ RequesterDashboard.tsx
│  │  │  └─ PatientApprovals.tsx
│  │  ├─ hooks/usePatientAccess.ts
│  │  └─ abi/PatientAccess.json              # 生成物（ABIコピー）
│  ├─ index.html
│  ├─ package.json / tsconfig.json / vite.config.ts
│  └─ .env.local                             # VITE_CONTRACT=...
├─ worker/
│  ├─ index.ts                               # ワーカー本体
│  ├─ config.json                            # ワーカー設定
│  ├─ abi/PatientAccess.json                 # 生成物（ABIコピー）
│  ├─ package.json / tsconfig.json
├─ docker-compose.yml                        # Orthanc×2, OHIF
├─ orthanc/requester.json                    # 認証OFF＋DICOMweb設定（Requester）
├─ ohif/app-config.js                        # （必要に応じて使用）
└─ README.md                                 # 手順メモ（本仕様書とは別）
```

---

## 4. 生成物一覧と役割
- `smart-contracts/deployments/localhost.json`
  - 直近のデプロイアドレス（`PatientAccess`, `MockERC20`）。
- `webapp/src/abi/PatientAccess.json`, `worker/abi/PatientAccess.json`
  - UI/Workerが参照するABI。`npm run export-abi`で同期。
- `smart-contracts/artifacts/` & `typechain-types/`
  - Hardhatのビルド成果物と型。

---

## 5. スマートコントラクト仕様（簡易）
### 5.1 主なデータ構造
- **Clinic**: クリニック登録情報（`clinicId`, `payout`, `operator`等）
- **Price**: Providerが公表するREAD/COPY価格（トークン/定額）
- **AccessRequest**: 個別申請（patient, providerClinicKey, requesterClinicKey, mode, token, price, status, manifestHash）
- **AccessBatch**: 複数Providerを束ねる申請（childIds[], totalPrice 等）

### 5.2 主要関数/イベント（抜粋）
- `createAccessBatch(patient, requesterClinicId, providers[], mode)`
  - 子リクエスト群を作成し、`AccessBatchCreated(batchId, childIds[])` をemit。
- `patientApprove(id)`
  - 申請の患者承認。`PatientApproved(id)` emit。
- `markFulfilled(id, manifestHash)`
  - Providerのoperatorが履行証跡（UID配列ハッシュ等）を添えて清算。`Fulfilled(id)` emit。
- `reqs(id)` / `batches(batchId)`
  - 状態参照。

### 5.3 状態遷移
`REQUESTED (0) → PATIENT_APPROVED (1) → FULFILLED (2)`

---

## 6. ワーカー仕様
### 6.1 役割
- `PatientApproved` イベントをポーリングで検知。
- `aliasResolver` により **patientアドレス → Provider側PatientID** を解決（PoCでは `map`/`passthrough`）。
- QIDOでインスタンス列挙 → WADOで取得 → Requester OrthancへPOST（またはRESTフォールバック）
- 取得したSOPInstanceUID群をソート連結→`keccak256`で`manifestHash`を生成。
- `markFulfilled(id, manifestHash)` を送信。

### 6.2 設定 `worker/config.json`
```json
{
  "rpcUrl": "http://127.0.0.1:8545",
  "chainId": 31337,
  "contractAddress": "<PatientAccess アドレス>",
  "clinics": {
    "PROV-001": { "role": "provider", "operatorPrivateKey": "<Provider-operator PK>", "priceToken": "<MockERC20>" }
  },
  "providers": {
    "PROV-001": {
      "qido": { "baseUrl": "http://localhost:8042", "auth": { "type": "basic", "username": "orthanc", "password": "orthanc" }, "issuer": "PROV-001" },
      "wado": { "baseUrl": "http://localhost:8042", "auth": { "type": "basic", "username": "orthanc", "password": "orthanc" } }
    }
  },
  "requester": { "orthanc": { "baseUrl": "http://localhost:8043" } },
  "aliasResolver": { "type": "map", "map": { "<患者Wallet>": "<Provider側PatientID>" } },
  "copy": { "mode": "orthanc", "batchSize": 32 },
  "logLevel": "info"
}
```

### 6.3 Orthanc連携（HTTP）
- **QIDO**: `GET /dicom-web/instances?PatientID={id}&includefield=00080018,0020000D,0020000E&limit=5000`
- **WADO-RS**: `GET /dicom-web/studies/{Study}/series/{Series}/instances/{SOP}` with `Accept: application/dicom`
- **UPLOAD**（Requester）: `POST /instances` （Content-Type: application/dicom）
- **RESTフォールバック**（任意）:
  1) `POST /tools/lookup`（body=文字列SOPInstanceUID）→ `ID`
  2) `GET /instances/{ID}/file` → 生DICOM

### 6.4 既存実装のポイント
- イベント検知は `queryFilter` + ポーリング（1.5s）。
- 二重実行防止の`processed`セット。
- 例外時の@TODOログ（URL・HTTPステータス出力推奨）。

---

## 7. Web UI 仕様
### 7.1 画面
- **RequesterDashboard**
  - 患者アドレス、Requester ClinicID、Providerリスト（複数）、READ/COPY選択
  - 送信→`AccessBatchCreated`/`AccessRequested`ログから `reqId` を抽出し表示
- **PatientApprovals**
  - 接続中ウォレット=患者の保留申請一覧を取得
  - `Approve` ボタンで `patientApprove(reqId)` 実行

### 7.2 接続
- MetaMask でアカウント切替（Requester/Patientを切替して動作確認）
- `.env.local`: `VITE_CONTRACT=<PatientAccess アドレス>`

---

## 8. DICOM & OHIF
### 8.1 docker-compose（要点）
- Provider (8042, 4242): 認証ON、`DICOM_WEB_PLUGIN_ENABLED=true`、`ORTHANC__DICOM_WEB__*` 有効
- Requester (8043): **開発時は認証OFF**（`orthanc/requester.json` をマウント）
- OHIF (3000): `?url=http://localhost:8043/dicom-web` または `app-config.js` で dataSources 定義

### 8.2 認証とOHIF
- OHIFの`?url=`方式はBasic認証ヘッダを自動付与しない
- 認証ONで使う場合は `ohif/app-config.js` で `dataSources` を定義し、ヘッダ付与 or APIキー方式を使う

### 8.3 動作確認コマンド
- QIDO: `curl -u orthanc:orthanc "http://localhost:8042/dicom-web/instances?limit=1"`
- WADO: `curl -u orthanc:orthanc "http://localhost:8042/dicom-web/studies/{Study}/series/{Series}/instances/{SOP}" -H "Accept: application/dicom" -o /tmp/test.dcm`
- Upload: `curl -X POST http://localhost:8043/instances --data-binary @/tmp/test.dcm -H "Content-Type: application/dicom"`

---

## 9. 起動・デモ手順（ローカル）
1) **Hardhat起動 & デプロイ**
   ```bash
   cd smart-contracts
   npx hardhat node --port 8545
   npm run deploy:localhost
   npm run export-abi
   ```
2) **DICOM & OHIF 起動**
   ```bash
   docker-compose up -d orthanc_provider orthanc_requester ohif
   # Requester 認証OFFは requester.json マウントで反映済
   ```
3) **Web UI**
   ```bash
   cd webapp
   echo "VITE_CONTRACT=<PatientAccessアドレス>" > .env.local
   npm i && npm run dev  # http://localhost:5173
   ```
4) **ワーカー**
   ```bash
   cd worker
   npm i && npm run dev
   # "PatientApproved <id> ... markFulfilled confirmed" を確認
   ```
5) **E2E**
   - Requester UIで申請 → Patient UIで承認 → Workerがコピー&清算 → OHIFで閲覧

---

## 10. 環境要件
- Node.js **v20.19+** 推奨（Vite要件）。
- npm 10+
- Docker / Docker Compose v2
- MetaMask（ローカルHardhat 31337に接続）

---

## 11. 既知の課題（v0.1）
- **OHIF Study Listが0件**の事象
  - Requester側にStudyが存在するか QIDOで確認（`/dicom-web/studies` が200かつ配列>0）
  - OHIFは `?url=` では認証を付けないため、認証ON時は `app-config.js` の `dataSources` 定義を利用
  - キャッシュ影響が大きいので強制リロード／シークレットで再確認
- **WADOレスポンスがMIME/JSON**で「Bad file format」
  - `Accept: application/dicom` を強制 or RESTフォールバック（`/tools/lookup`→`/instances/{id}/file`）
- **アドレス↔患者IDの突合**（aliasResolver）
  - 現状は静的`map`。将来はハッシュ化氏名・DOB・ClinicID等の照合スキーマを設計

---

## 12. 今後（ロードマップ）
### M1: 最小MVPの安定化
- Worker:
  - WADO失敗時のRESTフォールバック実装（UID→ID→file）
  - リトライ/バックオフ、部分失敗時の`manifestHash`生成ルール
- Web:
  - バッチ申請の子req一覧表示・ステータス更新ポーリング
  - OHIF起動リンク（`?url` or `dataSources`）の環境切替
- Contract:
  - 価格テーブル`Price`の設定UI、トークン承認（allowance）チェックUI

### M2: IDスキーマとセキュリティ
- 患者IDの別名管理（PatientAlias）をUIから登録
- 監査ログ（誰がいつ何をコピー）をオンチェーン/オフチェーンで突合
- Operatorロール/権限制御を厳密化

### M3: 本番準備
- 永続ネットワーク（例えばL2テストネット）対応
- 本物のPACS/QIDO+WADO/STS（OIDCやJWT）連携
- 決済の安定化（実トークン、価格改定、返金ポリシー）

---

## 13. 付録
### 13.1 docker-compose.yml（要点のみ）
```yaml
services:
  orthanc_provider:
    image: orthancteam/orthanc:latest
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
    ports: ["8043:8042"]
    volumes:
      - ./orthanc/requester.json:/etc/orthanc/orthanc.json:ro
      - ./data/requester:/var/lib/orthanc/db

  ohif:
    image: ohif/viewer:latest
    ports: ["3000:80"]
```

### 13.2 `orthanc/requester.json`
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

### 13.3 Workerのガード（例: 落ちにくくする）
- 重要箇所に `try/catch` を入れ、`console.error({ url, status, data })` で失敗点を可視化
- プロセスを落とさずに再試行（指数バックオフ）
- `processed` セットでイベント重複を抑止

---

以上。これをベースにPRレビュー/課題管理（Issues）を回せます。必要に応じ、コントラクトのABI/イベント仕様を別紙で詳述します。

