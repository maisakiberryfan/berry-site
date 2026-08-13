# fansite-v2 — 粉絲站 v3 重寫（社群評估版）

> 版本脈絡：**v1**＝最初的靜態 JSON 版 → **v2**＝現行站（DB＋API＋jQuery/Bootstrap/Tabulator）
> → **v3**＝本次重寫（本目錄）。位於 `fansite-v2` 分支，不影響 main／現站部署。
> ⚠️ 唯一的後端改動：`src/routes/setlist.js` PUT 增加 startTime/endTime 欄位支援
> （wiki 編輯時間戳用；向後相容，現站不受影響；已在測試 DB 實測）。

## 快速預覽

```bash
cd fansite-v2
npm install
npm run snapshot     # 從 production API 抓資料快照 → public/data/（唯讀 GET）
npm run dev          # http://localhost:5173（/api 代理到 production，唯讀瀏覽）
npm run dev:testdb   # http://localhost:5175（/api 代理到本地後端，接測試 DB 可測編輯）
```

`dev:testdb` 需要先起本地後端（entry-dev.js，接測試 DB）。

## 技術棧與架構

- **Vite 7 + Svelte 5（runes）+ Tailwind 4**，SPA，純靜態產物——部署模型不變（S3+CloudFront / CF Workers Static Assets 皆可）
- 全站 bundle **77.6KB gzip**（現站 jQuery+Bootstrap+Tabulator+Select2 為數倍）
- 無 jQuery/Bootstrap/Tabulator/Select2/DuckDB——表格（虛擬滾動）、下拉、圖表、lightbox 全自寫
- analytics 查詢：模板＝純 JS 聚合（0 下載）；自由 SQL＝sql.js（SQLite wasm 659KB self-host，
  lazy 首次執行才載）；資料用瀏覽器快取（最新值），sqldata.m-b.win parquet 管線已退役
- 草莓亮暗雙主題（色票同現站取樣）、三語 zh/en/ja（localStorage key `theme`/`lang` 沿用現站，偏好互通）
- wiki 式編輯：點列開 drawer 表單（無行內編輯），接既有 API（X-Source: user、composite key、rate limit 契約全對齊）

### 資料層（速度勝負手）

三層瀑布：**IndexedDB（回訪）→ CDN 快照 `/data/*.json`（首訪）→ API 背景增量校正**（songlist/streamlist 走 ETag 304；setlist 走 manifest 指紋比對只重抓變更月份）。

實測（首訪無快取，setlist 頁）：

| | 現站 | v2 |
|---|---|---|
| 首屏資料就緒 | 2.3s | **0.21s（15,896 筆全量）** |
| 全部資料就緒 | 5.8s | 0.21s（背景校正 <1s） |

## 驗證紀錄（2026-08-08）

- 9 頁全部渲染正常、console 零錯誤；亮暗×三語×手機響應式通過
- 編輯全流程實測（測試 DB）：PUT/POST/DELETE 皆綠、表格即時更新、測試資料已還原
- 資料層 13 項契約測試 PASS；IDB 掛住降級、API 非預期形狀保護已補
- 截圖見審閱訊息附檔

## 部署（demo 站 v3.m-b.win）

```bash
npm run snapshot && VITE_ASSET_BASE=https://m-b.win npm run build
BUCKET=berry-fansite-v3-495219733379 DISTRIBUTION_ID=E1ZENENQETM5MD bash scripts/deploy-sync.sh
```

`scripts/deploy-sync.sh` 取代裸 `aws s3 sync --delete`：Vite 是 hash 檔名，`--delete`
會即刻刪光舊 chunk，讓開著舊分頁的使用者 lazy-load 時吃 404。腳本改成
**hash 資產只增不刪、舊物件放置 14 天（`RETENTION_DAYS`）才回收**，非 hash 檔（index.html、
`data/*.json`）仍走 `--delete` 清死檔，invalidation 只清 `/index.html` 與 `/data/*`
（hash 資產免清）。`DRY_RUN=1` 可安全空跑。細節見 fansite-v2/CLAUDE.md 部署節。

CF 備用站（www.m-b.win）走 `wrangler.toml` 的 Workers Static Assets，已指向
`fansite-v2/dist`，由 `.github/workflows/deploy-cf.yml` 在 push main 時
`npm ci → npm run snapshot → npm run build → wrangler deploy`（**本分支合併進 main 才生效**）。

## 上線前 TODO（審閱通過後）

1. **快照管線**：`public/data/` 已 gitignore；CF workflow 已在 build 前跑 `npm run snapshot`
   （`continue-on-error`，抓不完整不擋部署，前端走 API 校正兜底）。AWS 側 workflow 待切換日改指向 fansite-v2。
   **快照新鮮度已補**：後端 cron `src/cron-jobs/snapshot.js`（EventBridge UTC 07:30／20:00）
   重產快照直接寫 S3 `data/` 並清 `/data/*` edge，可同時服務多站台（現站＋v3）。
   部署時需設 stack 參數 `SnapshotBucketA/B`、`SnapshotDistributionA/B`（經 CI secrets），未設＝自動 skip
2. **靜態資源**：~~部署時與新站同 bucket 發佈~~ **已解**——`/pages/history.md` 與
   `/changelog.json` 走 `/data/` 快照（snapshot 步驟已含）；`/img` CF 側由 deploy-cf 的
   「Bundle site images into dist」步驟併入（同源、CSP 免改），主站側 bucket 本來就有
   img/（切換日 deploy.yml 續 sync 即可）
3. AWS `deploy.yml` 改指向 fansite-v2 build（CF 側已改）；SPA 路由白名單（BotBlockerFunction spaRoutes）沿用（路徑相同免改）
4. 縮圖 `/tb/*` 沿用現有 CloudFront behavior 免改
5. 簡化取捨待確認：進階搜尋 7 運算子 → 全文搜尋＋篩選 chip；streamlist 右鍵選單、aliases batch UI 未做
6. ~~後端 text-to-sql prompt 加 SQLite 方言指示~~ **已過時**——text-to-sql 全鏈已於
   origin/main 移除（2026-08-09 Analytics 重寫，AI 小幫手退役）
7. S3 部署設定 `.wasm` 的 Content-Type `application/wasm`（未設有 ArrayBuffer fallback 不致命）
8. ~~CSP 可移除 `cdn.jsdelivr.net` 與 `sqldata.m-b.win` 例外~~ **origin/main 已於 2026-08-09
   移除**（本分支後端已於 2026-08-12 對齊 main：`entry-worker.js`／`template.yaml` 皆為新版 CSP）。
   移除後的 CSP 已相容 v3：sql.js 的 wasm 走同源＋`'wasm-unsafe-eval'`、Svelte/Tailwind 皆為
   打包後同源資產、v3 無 Web Worker（main 版已收掉 `worker-src blob:`）。**唯一要確認的是
   `style-src 'unsafe-inline'`**——v3 有 inline `style=""`，此項 main 版仍保留故無需改動
