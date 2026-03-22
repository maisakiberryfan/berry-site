# Berry Site

VTuber「苺咲べりぃ」非官方粉絲網站 — 統一後端 + 靜態前端。

> **程式碼來源**：本 repo 整合自以下四個原始 repo（已 archive）：
> - [maisakiberryfan/website](https://github.com/maisakiberryfan/website) — 前端靜態網站
> - [katy50306/m-b-setlist-parser](https://github.com/katy50306/m-b-setlist-parser) — 歌單解析 Worker
> - [katy50306/getyoutubevideoid](https://github.com/katy50306/getyoutubevideoid) — YouTube 影片代理
> - [katy50306/berry_hyperdrive](https://github.com/katy50306/berry_hyperdrive) — 資料庫 API

## 架構

```
使用者（台灣）
  │
  ├─ 主站 (m-b.win) ─→ CloudFront TPE
  │                      ├─ 靜態檔案 → S3
  │                      ├─ /tb/* → ThumbnailBucket (S3)
  │                      └─ /api/* → Lambda (ap-northeast-1)
  │                                    └─ MariaDB (ConoHa 大阪)
  │
  └─ 備用站 (www.m-b.win) ─→ CF Worker
                                ├─ 靜態檔案 → Workers Static Assets
                                └─ /api/* → Hono
                                             └─ Hyperdrive → MariaDB
```

### AWS（主站）

| 服務 | 用途 |
|------|------|
| CloudFront | CDN + SPA fallback + API 路由（TPE edge） |
| S3 | 靜態檔案 + 縮圖 hosting |
| Lambda (Node.js 24, arm64) | Hono API + Cron |
| EventBridge | Cron triggers + Lambda 保溫（每 5 分鐘） |
| ACM | SSL 憑證（us-east-1） |

### Cloudflare（備用站）

| 服務 | 用途 |
|------|------|
| Workers | Hono API |
| Workers Static Assets | 靜態檔案 hosting |
| Hyperdrive | DB 連線池（query cache 已關閉） |

### 共用

| 服務 | 用途 |
|------|------|
| MariaDB (ConoHa 大阪) | 主資料庫 |
| Lambda (setlist-matcher) | 歌單模糊比對 |

## 技術棧

- **後端**：Hono 4.9.7（雙入口：`entry-worker.js` / `entry-lambda.js`）
- **前端**：jQuery 3.7.1 + Bootstrap 5.3.8 + Tabulator 6.4.0 + DuckDB-WASM
- **建置**：esbuild
- **平台抽象**：`src/platform.js`（自動偵測 CF Workers / Lambda / 本地開發環境）

## CI/CD

Push 到 `main` 分支會自動觸發兩個 workflow：

### AWS (`.github/workflows/deploy.yml`)
1. Build fansite JS bundle
2. `sam build` → `sam deploy`（Lambda + CloudFront + S3）
3. Sync fansite 至 S3
4. Invalidate CloudFront cache

### Cloudflare (`.github/workflows/deploy-cf.yml`)
1. Build fansite JS bundle
2. `wrangler deploy`（Worker + Static Assets）

### 需要的 Secrets

**GitHub Actions (AWS)**：
| Secret | 說明 |
|--------|------|
| `AWS_ROLE_ARN` | IAM Role ARN（OIDC） |
| `DB_HOST` | MariaDB host |
| `DB_PORT` | MariaDB port |
| `DB_USER` | DB 使用者 |
| `DB_PASSWORD` | DB 密碼 |
| `DB_NAME` | DB 名稱（mbdb） |
| `YOUTUBE_API_KEY` | YouTube Data API v3 |
| `ANTHROPIC_API_KEY` | Claude API（text-to-sql） |
| `DISCORD_WEBHOOK_URL` | Discord 通知 |
| `DISCORD_SETLIST_WEBHOOK_URL` | Discord 歌單留言通知 |
| `TRIGGER_TOKEN` | /trigger-* 端點驗證 |
| `LAMBDA_MATCHER_URL` | Lambda setlist-matcher URL |
| `PUBSUB_CALLBACK_URL` | PubSub webhook URL |
| `GH_PAT_TOKEN` | GitHub PAT（commit 查詢） |

**GitHub Actions (Cloudflare)**：
| Secret | 說明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | CF API Token |
| `CLOUDFLARE_ACCOUNT_ID` | CF Account ID |

**Cloudflare Worker Secrets**（透過 `wrangler secret put`）：
- `YOUTUBE_API_KEY`, `ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL`, `DISCORD_SETLIST_WEBHOOK_URL`, `TRIGGER_TOKEN`, `PUBSUB_CALLBACK_URL`, `GITHUB_TOKEN`

## 本地開發

```bash
# 安裝依賴
npm install
cd fansite && npm install && cd ..

# CF 路徑（wrangler dev，含靜態檔案）
npm run dev          # http://localhost:8787

# AWS 路徑（SAM local）
sam build && sam local start-api --port 3001 --env-vars .env.json

# Fansite JS bundle
cd fansite && npm run build:js
```

### 環境檔案

| 檔案 | 用途 | Git |
|------|------|-----|
| `.dev.vars` | wrangler dev 環境變數 | ignored |
| `.env.json` | SAM local 環境變數 | ignored |
| `.env` | 正式環境變數（參考用） | ignored |

## Cron Triggers

```
UTC 07:00           = 台灣 15:00         每日備援 runAutoUpdate
UTC 14:00~19:00     = 台灣 22:00~03:00   每 10 分鐘 runPollingCheck
rate(5 minutes)                           Lambda 保溫（避免 cold start）
```

AWS EventBridge 為主要排程，CF Worker cron 已停用。

## API 端點

所有 API 路由加 `/api/` 前綴，詳見 `src/app.js` 及 `src/routes/`。

| 模組 | 說明 |
|------|------|
| `/api/songlist` | 歌曲 CRUD |
| `/api/streamlist` | 直播 CRUD |
| `/api/setlist` | 歌單 CRUD |
| `/api/aliases` | 別名管理 |
| `/api/yt` | YouTube 影片查詢 |
| `/api/parse-setlist` | 歌單解析 |
| `/api/text-to-sql` | AI SQL 查詢 |
| `/health` | 健康檢查 |
| `/webhook/youtube` | PubSubHubbub webhook |

## 文件

- `docs/architecture-diagram.html` — 互動式架構圖（排程流程、模組依賴、前端 SPA）
