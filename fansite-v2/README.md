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

## 上線前 TODO（審閱通過後）

1. **快照管線**：`public/data/` 已 gitignore；CI 需在 build 前跑 `npm run snapshot`（或後端 cron 直接寫 S3，之後可換）
2. **靜態資源**：`/img`、`/pages/history.md`、`/changelog.json` 目前 dev proxy 到現站線上——部署時與新站同 bucket 發佈（沿用 fansite/ 的檔案即可）
3. CI workflow 改指向 fansite-v2 build；SPA 路由白名單（BotBlockerFunction spaRoutes）沿用（路徑相同免改）
4. 縮圖 `/tb/*` 沿用現有 CloudFront behavior 免改
5. 簡化取捨待確認：進階搜尋 7 運算子 → 全文搜尋＋篩選 chip；streamlist 右鍵選單、aliases batch UI 未做
6. **後端 text-to-sql prompt 加 SQLite 方言指示**（＋startTime/endTime 欄位說明）——新站上線切換時改 src/routes/（demo 期靠「錯誤回丟修一次」自癒）
7. S3 部署設定 `.wasm` 的 Content-Type `application/wasm`（未設有 ArrayBuffer fallback 不致命）
8. CSP 可移除 `cdn.jsdelivr.net` 與 `sqldata.m-b.win` 例外（DuckDB/parquet 退役後不再需要；entry-worker.js 與 template.yaml 兩側同步）
