# Claude Code 專案設定

## 語言偏好

- **思考語言**：繁體中文
- **回應語言**：繁體中文
- **程式碼註釋**：中文或英文

---

## 專案概述

VTuber「苺咲べりぃ」非官方粉絲網站。

> **歷史**：本 repo 整合自 `berry_pro/` 下的四個獨立 repo（已 archive）：
> `maisakiberryfan/website`、`katy50306/m-b-setlist-parser`、`katy50306/getyoutubevideoid`、`katy50306/berry_hyperdrive`。
> 遷移計畫與歷史紀錄在 `~/.claude/projects/E--website-berry-pro/memory/` 中。

```
berry-site/
├── fansite/                   # 前端靜態網站
│   └── assets/js/tool.js      # 主要前端邏輯
├── src/                       # 後端共用程式碼（Hono app）
│   ├── app.js                 # 主應用程式 + 路由
│   ├── config.js              # CORS 設定
│   ├── database.js            # DB 連線管理（含 ping 保護）
│   ├── platform.js            # 平台抽象（CF/Lambda/本地）
│   └── routes/                # API 路由模組
├── entry-worker.js            # CF Workers 入口
├── entry-lambda.js            # AWS Lambda 入口
├── template.yaml              # AWS SAM 模板
├── wrangler.toml              # CF Workers 設定
└── lambda/setlist-matcher/    # Lambda 歌單模糊比對（獨立部署）
```

---

## 架構

### 雙平台（同一份 Hono app）

| | AWS（主站 m-b.win） | Cloudflare（備用站 www.m-b.win） |
|--|---------------------|-------------------------------|
| 入口 | `entry-lambda.js` | `entry-worker.js` |
| 靜態檔案 | S3 + CloudFront | Workers Static Assets |
| API | Lambda (Node.js 24, arm64) | CF Worker |
| DB 連線 | mysql2 直連 | Hyperdrive 連線池（query cache 已關閉） |
| Cron | EventBridge（主要） | 已停用 |
| CDN | CloudFront TPE edge | CF（免費方案台灣繞 SIN） |

### 平台抽象 (`src/platform.js`)

```javascript
getDbConfig(env)  // CF: env.HYPERDRIVE → Lambda: process.env.DB_*
getSecret(env, name)  // CF: env[name] → Lambda: process.env[name]
```

wrangler dev 時 `.dev.vars` 注入到 `c.env`（不是 `process.env`）。

---

## 前端（fansite/）

### 技術棧
- jQuery 3.7.1 + Bootstrap 5.3.3（深色主題）
- Tabulator 6.4.0 + Select2 4.1.0-rc.0（IME 支援，必須用 rc.0）
- DuckDB-WASM（Analytics）
- esbuild 建置（`--format=esm`，因 top-level await 不支援 iife）
- 自訂 SCSS 用 `@use ... with` 覆寫 Tabulator 變數 + CSS custom properties 實現 dark mode（比官方 dark mode 更完善）

### 核心功能
- 三語言系統（zh/en/ja）+ 瀏覽器自動偵測
- 即時編輯：Tabulator inline editing + API 同步
- 聯動篩選：HeaderFilter cascade filtering + 模糊搜尋
- SPA 路由：`setContent(path)` + `history.pushState`

### ⚠️ SPA 路由同步
新增前端頁面路由時，**必須同步更新** `template.yaml` 的 `BotBlockerFunction` 中 `spaRoutes` 陣列。
路由清單來源：`fansite/assets/data/nav.json`
- `Promise.allSettled` 確保首頁各區塊獨立載入

### 建置
```bash
cd fansite && npm run build:js   # esbuild bundle → assets/dist/
```

---

## 後端（src/）

### API 端點（全部加 `/api/` 前綴）

| 路由 | 說明 |
|------|------|
| `/api/songlist` | 歌曲 CRUD |
| `/api/songlist/artists` | 藝人列表 |
| `/api/songlist/optimized` | 優化版歌曲查詢 |
| `/api/songlist.json` | 前端用歌曲 proxy |
| `/api/streamlist` | 直播 CRUD |
| `/api/streamlist/latest` | 最新直播 |
| `/api/streamlist/pending` | 待解析歌枠 |
| `/api/setlist` | 歌單 CRUD（composite key: streamID/segmentNo/trackNo） |
| `/api/aliases` | 別名管理 |
| `/api/yt?id={videoId}` | 單一影片資訊 |
| `/api/yt/latest` | 最新影片（從 DB） |
| `/api/yt/newvideos` | 多頻道新影片查詢 |
| `/api/yt/live-details?id={videoId}` | 直播狀態（isLive, isEnded） |
| `/api/parse-setlist` | 歌單解析（呼叫 Lambda matcher） |
| `/api/get-comments` | YouTube 留言抓取 |
| `/api/text-to-sql` | AI SQL 查詢（Haiku 4.5，每日 $0.1 預算） |
| `/api/stats/last-updated` | 各表最後更新時間 |

### 基礎設施路由（無 `/api/` 前綴）

| 路由 | 說明 |
|------|------|
| `/health` | 健康檢查 + DB 連線測試 |
| `/webhook/youtube` | PubSubHubbub webhook（GET 驗證 / POST 通知） |
| `/trigger-update` | 手動觸發更新（POST, body: `{mode: "recent"\|"all"}`) |
| `/trigger-setlist-parse?streamID=xx` | 手動解析歌單（GET, 可加 `&force=true` 跳過歌枠檢查） |

### Cron Triggers

```
UTC 07:00       = 台灣 15:00     每日備援 runAutoUpdate
UTC 14:00~19:00 = 台灣 22:00~03:00  每 10 分鐘 runPollingCheck
```

AWS EventBridge 為主要排程。CF cron 已停用。

### 資料庫（MariaDB @ ConoHa 大阪）

- `songlist`：歌曲資訊
- `streamlist`：直播資訊
- `setlist_ori` → `setlist` VIEW（JOIN songlist + streamlist）
- `aliases`：歌曲別名

### Lambda setlist-matcher

- 位置：`lambda/setlist-matcher/`
- 配置：threshold=0.88, titleWeight=0.75, artistWeight=0.25
- 環境變數：`BERRY_SITE_API_URL`（指向主站 API）
- 部署：`sam build && sam deploy`（獨立 SAM stack）

### CloudFront 架構

**Origins**：
- `S3Origin` → FansiteBucket（靜態檔案）
- `ThumbnailOrigin` → ThumbnailBucket（縮圖，key: `tb/{streamID}.jpg`）
- `ApiOrigin` → API Gateway

**CacheBehaviors**：
| 路徑 | Origin | 快取 |
|------|--------|------|
| `/tb/*` | ThumbnailOrigin | CachingOptimized |
| `/api/*` | ApiOrigin | CachingDisabled |
| `/webhook/*` | ApiOrigin | CachingDisabled |
| `/trigger-*` | ApiOrigin | CachingDisabled |
| `/health` | ApiOrigin | CachingDisabled |
| `*`（預設） | S3Origin | CachingOptimized + BotBlockerFunction |

**BotBlockerFunction**（CloudFront Function, viewer-request）：
- 惡意路徑（`.php`, `/wp-*`, `/.env`）→ 404
- SPA 路由白名單 → rewrite `/index.html`
- 其他 → 交給 S3（存在=200，不存在=真 404）

**存取日誌**：LogBucket（30 天自動過期）

### 縮圖系統

- 新影片透過 `runAutoUpdate` / PubSub 自動下載到 S3（`src/utils/thumbnail.js`）
- 前端 `imageLink()` 使用 `/tb/{id}.jpg`，onerror fallback YouTube CDN
- 小於 5KB 視為 YouTube 預設佔位圖，跳過上傳

---

## CI/CD

Push 到 `main` 自動觸發：

### AWS (`.github/workflows/deploy.yml`)
1. Build fansite JS → `sam build` → `sam deploy`
2. Sync fansite 至 S3（`--size-only` 跳過未變更檔案）
3. Invalidate CloudFront cache

### Cloudflare (`.github/workflows/deploy-cf.yml`)
1. Build fansite JS → `wrangler deploy`

### Secrets

見 README.md。

---

## 本地開發

```bash
# CF 路徑（含靜態檔案 + API）
npm run dev                    # wrangler dev → http://localhost:8787

# AWS 路徑（API only）
sam build && sam local start-api --port 3001 --env-vars .env.json

# 前端 bundle
cd fansite && npm run build:js
```

| 檔案 | 用途 |
|------|------|
| `.dev.vars` | wrangler dev 環境變數 |
| `.env.json` | SAM local 環境變數 |
| `.env` | 正式環境參考 |

---

## 重要提醒

### Hyperdrive
- 使用 `connection.query()` 替代 `connection.execute()`（COM_STMT_PREPARE 限制）
- 必須保留 `disableEval: true`
- Query cache 已關閉（避免編輯後顯示舊資料）

### Select2 IME
- 必須使用 **4.1.0-rc.0**（非 4.0.13）

### DB 連線
- `database.js` 的 `ping()` 有 3 秒 timeout 保護
- CF Workers TCP socket 行為跟 Node.js 不同，壞連線不會自動偵測

### Setlist Composite Key
- 路由：`/api/setlist/:streamID/:segmentNo/:trackNo`
- 新增 row 用 `_isNew` flag 區分 POST/PUT

### PubSubHubbub 訂閱
- Lease 5 天，由 `runAutoUpdate` 每 4 天自動續訂
- **DNS 切換、長時間中斷後必須手動重新訂閱**（lease 過期 + callback 不可達 = 訂閱失效）
- 手動訂閱指令：
  ```bash
  for CH in UC7A7bGRVdIwo93nqnA3x-OQ UCBOGwPeBtaPRU59j8jshdjQ UC2cgr_UtYukapRUt404In-A; do
    curl -X POST https://pubsubhubbub.appspot.com/subscribe \
      -d "hub.callback=https://m-b.win/webhook/youtube&hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=$CH&hub.verify=async&hub.mode=subscribe&hub.lease_seconds=432000"
  done
  ```
- 驗證：log 應出現 `GET /webhook/youtube?hub.challenge=...` 回應 200

### 部署
- **AWS / CF**：push 到 GitHub 自動部署
- **Lambda matcher**：需手動 `sam build && sam deploy`

### Lambda 保溫（EventBridge Keep-Warm）
- EventBridge Rule 每 5 分鐘觸發 Lambda `/health`
- 避免 cold start（首次請求延遲 ~400ms-5s）
- 完全在免費額度內（8,640 次/月 << 100 萬次免費）
- 設定在 `template.yaml` 的 `WarmUpRule` 資源

### 費用
- 全部在 AWS/CF 免費額度內（預估 < $0.20/月）
- EventBridge 保溫：免費
- text-to-sql 每日預算 $0.10

---

## 版本歷史

| 版本 | 日期 | 主要更新 |
|------|------|----------|
| v3.1 | 2026-03-21 | SPA 路由白名單、縮圖 S3 存儲、Polling 10 分鐘、CloudFront 存取日誌 |
| v3.0 | 2026-03-18 | AWS 遷移完成：CloudFront + Lambda + S3、CI/CD、舊 Workers 停用 |
| v2.9 | 2026-02-26 | PubSub 直播時間修正 |
| v2.8 | 2026-01-20 | Analytics SQL 小幫手 |
| v2.7 | 2025-12-29 | 多語言優化、GitHub commit 代理 |

**最後更新**：2026-03-21
