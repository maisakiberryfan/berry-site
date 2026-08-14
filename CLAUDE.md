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
- jQuery 3.7.1 + Bootstrap 5.3.8（**SCSS 客製編譯**，亮暗雙主題）
- Tabulator 6.5.2 + Select2 4.1.0（IME 支援；4.0.13 組字有致命 bug 勿降版，
  2026-08-08 由 rc.0 升正式版、日文組字全流程實測通過。**任何 Select2 升級都必須重測 IME**）
- sql.js 1.14（Analytics 進階 SQL；SQLite/WASM self-host 於 `assets/vendor/`，
  按下執行才載入 ~0.64MB wasm。取代 DuckDB-WASM＋parquet，見下方 Analytics 節）
- 表格快取：IndexedDB（idb-keyval，store `berry-cache`/`tables`；IDB 不可用時降級直抓 API）
- 資料載入三層瀑布：IndexedDB → CDN 靜態快照（`/data/*.json`）→ API 增量校正（見下節）
- esbuild 建置（`--format=esm`，因 top-level await 不支援 iife）
- 自訂 SCSS 用 `@use ... with` 覆寫 Tabulator 變數 + CSS custom properties 實現 dark mode（比官方 dark mode 更完善）

### 主題色系統（苺咲べりぃ配色，色碼取樣自官方 logo/symbol @ `img/profile/`）
- `assets/css/bootstrap-berry.scss`：**官方 Sass 變數覆蓋路線**（先設 `$primary`/`$body-bg`/
  `$*-dark` 再 `@import bootstrap`），primary=草莓紅 `#E24368`，衍生色（hover/focus ring/
  subtle/emphasis）編譯期自動生成。亮色主題=草莓牛奶（`#FCF4F6` 底＋深草莓連結）為**預設**；
  暗色主題=暗莓（`#261A21` 系＋徽章粉連結 `#F193AB`）。產物 `bootstrap-berry.css` **進 git**
  （同 tabulator 慣例，CI 只跑 build:js 不重編）——改 scss 後必須 `npm run build:bootstrap`
- `assets/css/theme-berry.css`：裝飾層（navbar 漸層線＋brand 色、兩角光暈、h2 hairline、
  `.table-dark` 硬編色跟隨主題、Tabulator 表頭底線/編輯格、工具列按鈕暗色提亮）；
  bundle 順序必須排在 bootstrap-berry 與 tabulator CSS 之後
- `assets/js/theme-init.js`：head 內**同步** script（CSP 禁 inline 故獨立成檔），首繪前套用
  主題防閃爍。優先序：`?theme=` 測試 override（不落地）> localStorage（切換鈕選過）
  > 系統 prefers-color-scheme > light。navbar 切換鈕（`#themeToggle`）寫 localStorage
- ⚠️ 新增 UI 勿硬編亮/暗前提 class（`btn-outline-light`、`bg-dark text-light`、
  `table-dark` 例外——表格容器沿用它但變數已跟隨主題），一律用主題自適應變數/元件

### 資料載入三層瀑布（首訪加速；2026-08-09 由 fansite-v2 移植）

```
IndexedDB 快取  →  CDN 靜態快照 /data/*.json  →  API 增量校正
（回訪，不變）      （首訪，edge 直出）           （既有 manifest/ETag 邏輯）
```

- **快照產生**：`npm run snapshot`（＝`node fansite-v2/scripts/fetch-snapshot.mjs`，
  純 Node 無相依）向正式 API 唯讀 GET，輸出到 `fansite-v2/public/data/`（**gitignored**，
  部署時重建，vite build 會連同 `public/` 拷進 `dist/data/`）：
  `songlist.json`、`streamlist.json`、`yt-latest.json`、`manifest.json`、
  `setlist-{YYYY-MM}.json`（每月一檔）＋`setlist-none.json`
  ＋`history.md`／`changelog.json`（現站靜態檔，CI 隨後以 repo 版覆蓋，見下）。
  `BERRY_API=http://localhost:8788` 可改抓本地 API。
  單檔失敗不中斷但**整支 exit 1**，CI 據此跳過同步（保住線上既有的完整快照）——
  **manifest 形狀不對（缺 months 陣列）與 songlist/streamlist/月度檔非陣列同樣計入
  failures**：AWS 側的 `s3 sync --delete` 吃這個 exit code，靜默 exit 0 會清空線上 /data/
  （v2 舊版本的根目錄腳本已於 2026-08-14 除役刪除）
- **前端**（tool.js）：IDB 無快取時才抓快照。setlist 走 `primeSetlistFromSnapshot()`——
  manifest 快照給月份清單並 **seed fingerprints**，逐月快照併發 6 抓齊後灌入，之後
  **照常走既有的 manifest 比對**：快照過時的月份指紋對不上、自動由 API 重抓（缺檔的月份
  不寫指紋，效果同缺月自癒）。songlist/streamlist 用整包快照當 Tabulator 初始 data，
  校正交給既有的 `backgroundFetchAndUpdate`
- **etag 一律為 null**：靜態快照沒有 ETag，帶假值會 304 短路把過時資料鎖死
- **fallback**：快照 404／解析失敗 → 回傳 null → 完全走原本的 API 路徑（首訪漸進載入
  不變），代價只是一個 404 往返
- **CI**：build **之前**跑 `npm run snapshot`（`continue-on-error`——快照抓不全不該擋部署），
  緊接著用 repo 的 `fansite/pages/history.md`／`fansite/changelog.json` 覆蓋快照抓來的線上版
  （快照是從 m-b.win 抓的，此刻線上還是上一次部署的內容，不覆蓋就永遠落後一次部署）；
  AWS 側 `fansite-v2/dist/data/` 獨立一輪 s3 sync（`max-age=300`＋`--delete`，
  不用 `--size-only`，且 `if: steps.snapshot.outcome == 'success'`），
  CF 側隨 Workers Static Assets 一起上傳。CloudFront 的 `/*` invalidation 已涵蓋 `/data/`
- **新鮮度**：快照只跟得上「最近一次部署」，這是設計的一部分——正確性由 API 校正保證，
  快照只負責讓首訪先有東西看

### Analytics（`pages/analytics.htm` ＋ `assets/js/analytics.js` ＋ `assets/js/analytics/`）

頁內兩個分頁籤：**統計**（第一屏、零下載）與**資料查詢**（引擎按需載入）。

- **資料源＝瀏覽器既有快取**：`window.loadBerryTables()`（tool.js）以與表格頁相同的
  三層瀑布（IDB → CDN 快照 → API）取回 setlist／songlist／streamlist。
  **不再有 `sqldata.m-b.win` 的每日 parquet 管線**（VPS 匯出 cron 與 R2 bucket 待退役）
- **統計面板**：純 JS 聚合（統計卡、Top 20 曲、Top 10 歌手、24 個月趨勢），
  圖表為自繪 SVG（`analytics/charts.js`，無圖表庫）。色彩全走 CSS 變數
  （`--berry-primary`/`--berry-pink` ＋ `--bs-*` 文字/邊框階層），亮暗自適應
- **查詢建構器**（`analytics/builder.js`）：欄位勾選＋7 運算子＋6 聚合＋SQL 即時預覽。
  欄位名走 `DATASET_COLUMNS` 白名單、運算子走固定表、**值一律 bind（`?`）**、
  LIKE 另加 `ESCAPE '\'` ⇒ 使用者輸入不可能變成語法
- **進階 SQL**：`analytics/engine.js` 以原生 `<script src>` 載入 self-host 的
  `assets/vendor/sql-wasm-browser.{js,wasm}`（sql.js 1.14，**按下執行才載**）。
  版本由 `fansite/package.json` 的 `sql.js` 相依管理，升級後跑 `npm run vendor:sqljs`
  重新複製產物（vendor 檔進 git，同 `xlsx.full.min.js` 慣例）
- **時間語意（全部本地時區）**：寬表的 `time` 在建表時就轉成瀏覽器時區的
  `'YYYY-MM-DD HH:MM'` 固定寬度字串（SQLite 無 timestamp 型別，字典序＝時序），
  使用者直接寫本地日期即可；統計面板的月度分桶同樣用本地月（2026-08-09 用戶指正
  統一——原沿用 v3 的 UTC 桶會讓跨月深夜場與查詢的 `month` 對不上）。代價：統計桶
  與後端 manifest 的 UTC 月度分段不可直接對帳（僅影響開發者除錯）
- **三語**：靜態文字走 `data-lang` span（`updatePageLang`）；JS 動態產生的內容走
  `analytics/i18n.js` 字典（動態節點不在 `updatePageLang` 掃描時機內）
- **已移除**：AI「SQL 小幫手」（`/api/text-to-sql`、`ai_usage` 預算表、`ANTHROPIC_API_KEY`）
  與 DuckDB-WASM；CSP 兩側同步移除 `cdn.jsdelivr.net`、`sqldata.m-b.win`

### 表格快速搜尋語法（`欄位:值`；2026-08-09 由 fansite-v2 移植）

四張表頁（songlist/streamlist/setlist/aliases）的「進階搜尋」卡片首列＝**快速搜尋框**，
即時過濾（200ms debounce、IME 組字中不觸發、Enter 立即套用）。

- **語法本體**：`fansite/assets/js/table-search.js`（`tokenize` / `buildHaystack` /
  `matchesQuery` 三支純函式＋四表的 `SEARCH_SPECS`）。空白分隔＝AND、引號括住含空白的值、
  全形冒號「：」／全形空白／彎引號一併吃、`欄位:*`＝該欄不為空
- **關鍵設計**：欄位名比不到別名表時，**整個 token（含冒號）退回全文比對**——
  時間「12:34」不會被誤拆成 `12` 欄位。別名表以 `hasOwnProperty` 把關
  （`constructor:x` 這類 key 會撈到 Object.prototype 成員，直接用會炸）
- **別名表三語都收**（`曲名`/`song`/`曲名`、`歌手`/`artist`/`アーティスト`…），key 一律小寫；
  雙語欄（曲名/歌手）同時比日文與英文欄，與各表 headerFilterFunc 既有行為一致
- ⚠️ **取值對象是 Tabulator 的列資料（已過 mutator）**：setlist/streamlist 的 `time`
  是 `'YYYY/MM/DD HH:mm'` 本地字串（不是 ISO），不留檔場（time NULL）會是 `'Invalid Date'`。
  日期一律走 `dateText()`（同時吐斜線與短橫線兩版、`Invalid Date` 視同空）
- **與多欄運算子搜尋並存**：兩者狀態各自維護，最後由 `applyTableFilters()` 併成單一
  custom filter 送 `setFilter`。Tabulator 的 `setFilter` 會整組取代既有程式化 filter，
  **兩邊各自呼叫必定互相清掉**——新增任何程式化篩選都必須走這個出口。
  headerFilter 是另一組，Tabulator 自己 AND 起來，不受影響
- 條件全空時用 `clearFilter()`（不帶 `true`）：帶 `true` 會連 headerFilter 一起清掉，
  刪空搜尋框不該連欄頭篩選一起沒。整組清空由「清除」鈕與「重新載入」負責
- 「?」說明面板為 Bootstrap collapse 的宣告式 `data-bs-toggle`（無 inline script，CSP 相容），
  三語走 `data-lang` 區塊；範例可點擊直接套用，**值取自實際資料**（點下去不會 0 筆）

### 核心功能
- 三語言系統（zh/en/ja）+ 瀏覽器自動偵測
- 即時編輯：Tabulator inline editing + API 同步
- 聯動篩選：HeaderFilter cascade filtering + 模糊搜尋 + 快速搜尋語法（見上節）
- SPA 路由：`setContent(path)` + `history.pushState`

### ⚠️ SPA 路由同步
新增前端頁面路由時，**必須同步更新** `template.yaml` 的 `BotBlockerFunction` 中 `spaRoutes` 陣列。
路由清單來源：`fansite/assets/data/nav.json`
- `Promise.allSettled` 確保首頁各區塊獨立載入

### 建置
```bash
cd fansite && npm run build:js         # esbuild bundle → assets/dist/（CI 跑這個）
cd fansite && npm run build:bootstrap  # bootstrap-berry.scss → .css（改主題 scss 後必跑，產物進 git）
cd fansite && npm run build            # 全部（bootstrap + tabulator + js）
cd fansite && npm run vendor:sqljs     # sql.js dist → assets/vendor/（升 sql.js 後必跑，產物進 git）
npm run snapshot                       # repo 根：＝ node fansite-v2/scripts/fetch-snapshot.mjs
                                       # → fansite-v2/public/data/（CI 在 fansite-v2/ 內跑同一支）
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
| `/api/setlist` | 歌單 CRUD（composite key: streamID/segmentNo/trackNo）；GET 支援 `?from=YYYY-MM&to=YYYY-MM` 月度區段、`from=none`＝不留檔場 bucket |
| `/api/setlist/manifest` | 每月 {month, count, maxUpdated} 清單（前端月度增量比對用，與全量端點共用 meta ETag） |
| `/api/setlist/:streamID/:segmentNo/reorder` | PUT 曲序修正，body `{order:[現有 trackNo 的完整排列]}`；⚠️ 寫回後 trackNo **重編為 1..N 連續**（原有空洞被正規化），回應帶該段落重排後完整列供前端整段替換。路由**必須註冊在 `:trackNo` param 路由之前** |
| `/api/aliases` | 別名管理 |
| `/api/yt?id={videoId}` | 單一影片資訊 |
| `/api/yt/latest` | 最新影片（從 DB） |
| `/api/yt/newvideos` | 多頻道新影片查詢 |
| `/api/yt/live-details?id={videoId}` | 直播狀態（isLive, isEnded） |
| `/api/parse-setlist` | 歌單解析（呼叫 Lambda matcher）；需 token（同 `/trigger-*`） |
| `/api/stats/last-updated` | 各表最後更新時間 |

### 基礎設施路由（無 `/api/` 前綴）

| 路由 | 說明 |
|------|------|
| `/health` | 健康檢查 + DB 連線測試 |
| `/webhook/youtube` | PubSubHubbub webhook（GET 驗證 / POST 通知） |
| `/trigger-update` | 手動觸發更新（POST, body: `{mode: "recent"\|"all"}`）需 token |
| `/trigger-setlist-parse?streamID=xx` | 手動解析歌單（GET, 可加 `&force=true`）需 token |

所有 `/trigger-*` 端點（與 `/api/parse-setlist`）需帶 `X-Trigger-Token` header，由 `TRIGGER_TOKEN`
環境變數驗證。**不支援 `?token=` query**（query string 會留在存取日誌與瀏覽器歷史中）：

```bash
curl -s -H "X-Trigger-Token: $TOKEN" "https://m-b.win/trigger-setlist-parse?streamID=xxx"
curl -s -X POST -H "X-Trigger-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"recent"}' "https://m-b.win/trigger-update"
```

### Cron Triggers

```
UTC 07:00       = 台灣 15:00     每日備援 runAutoUpdate
UTC 14:00~19:00 = 台灣 22:00~03:00  每 10 分鐘 runPollingCheck
UTC 07:30       = 台灣 15:30     runSnapshot（每日更新後重產 CDN 快照）
UTC 20:00       = 台灣 04:00     runSnapshot（polling 末發 19:50 之後重產 CDN 快照）
```

AWS EventBridge 為主要排程。CF cron 已停用。

前三者走 `event.source === 'aws.events'` → `handleCronTrigger`（依 UTC 小時分派）；
快照排程改帶 `Input: '{"source":"snapshot"}'`，在 `entry-lambda.js` 直接分流到
`src/cron-jobs/snapshot.js`（同 warmup 的作法）。

### CDN 快照 cron（src/cron-jobs/snapshot.js）

`/data/*.json` 靜態快照原本只在部署時產（CI `npm run snapshot`），資料一更新就過期——
前端有 API 背景校正兜底，但首訪體感差，故兩次／日重產：

- 資料源用 Hono `app.request()` **內部調用自家 API**（零網路來回，輸出與前端拿到的一致）；
  `history.md`／`changelog.json` 是現站靜態檔不是 API，走 HTTP 抓（`SNAPSHOT_STATIC_BASE`）
- **取法刻意分歧（2026-08-14）**：cron 版＝一次全量 `/api/setlist` ＋ Node 端
  `bucketSetlistByMonth()` 分桶（77→2 次調用，等價性見該函式註解，73 檔位元組級對照
  驗證過）；CI 版（`fansite-v2/scripts/fetch-snapshot.mjs`）維持逐月抓。**輸出契約
  （檔名／信封／排序）兩處必須一致**（v2 時代的根目錄版已除役刪除）
- 目標站台：`SNAPSHOT_TARGETS`＝`bucket:distributionId,bucket2:distributionId2`
  （由 template 的 SnapshotBucketA/B ＋ SnapshotDistributionA/B 以 `!Sub` 拼成；
  **未設＝整個步驟 skip 並 log**）。CacheControl 固定 `public, max-age=300`，
  與 CI 的快照 sync 逐字一致；每站台寫完發一次 `/data/*` invalidation（1 path）
- **manifest.json 一定最後寫**（commit point）：新 manifest ＋ 尚未更新的月度檔會讓前端
  指紋對得上卻讀到舊資料且不自癒；反過來只是多一輪 API 校正。putAll 因此拆兩批依序
  await（併發池內的完成順序不保證，光排在陣列尾端沒用）
- **時間預算 120s**（Lambda Timeout 180s）：逐月迴圈超時就停止剩餘月份、ok=false，
  且**不寫 manifest**；剩餘月份仍登記進 wanted 清單，免得清理把它們的 S3 舊檔誤刪
- 失敗語意：單檔失敗只記錄不中斷（舊物件留在 S3 比缺檔安全）；某站台一個檔都沒寫成時
  **不執行清理**（只刪不寫是最糟的組合）；清理自帶 try/catch（它拋錯不該連帶跳過
  invalidation）。manifest 失敗／預算用盡／有站台全滅 → 整體 ok=false，
  **並發 Discord 通知**（`type: 'snapshot'`；cron 沒人盯 CloudWatch，靜默＝快照停在舊版
  卻沒人知道。通知失敗不影響 cron 結果）
- 內部調用帶 `MODE: 'dev'`（`apiEnv`）＋失敗時讀 body 的 `error.message`：app.js 的
  onError 只在 dev/test 附上真實錯誤，否則連未捕例外都只剩 "Internal server error"。
  回應不外流（僅進 log／通知）。上限：路由層自己 catch 的錯誤本來就回泛化字串，
  真因得看該路由 console.error 的 CloudWatch log

### 資料庫（MariaDB @ ConoHa 大阪）

- `songlist`：歌曲資訊
- `streamlist`：直播資訊
- `setlist_ori` → `setlist` VIEW（JOIN songlist + streamlist，YTLink 含 `?t=startTime`）
  - `startTime INT NULL`（秒數）、`endTime INT NULL`（秒數）— 從 YouTube 留言回補；
    亦可前端編輯模式直接編輯（timeEditor：h:mm:ss/m:ss/秒；PUT 驗證 null 或 0~360000，
    與 fansite-v2 同一套 API 更新方法）
- `aliases`：歌曲/歌手別名
  - title 別名可綁 `songID`（精準對應、同名異曲不互染）；artist 別名為字串表（跨曲共用，設計如此）
  - 快速新增別名（setlist 右鍵）title 模式自動帶 songID

### Lambda setlist-matcher

- 位置：`lambda/setlist-matcher/`
- 配置：threshold=0.88, titleWeight=0.75, artistWeight=0.25
  - 無歌手行：純 titleScore、門檻 0.95（同名 dedup 兜底）
  - 序號感知（II/Ⅱ/2/弐，數值化比較、ii 前為拉丁字母不視為序號）、日英欄位並比取最高、
    多段括號/三段式行解析；豎線近似字（│￨ǀ∣┃¦）正規化為 `|`；裸斜線「曲/歌手」行於
    第一輪落空時 fallback 切分重比（切過仍落空的行帶 fallbackSplit 標記，主站拒建新曲）
  - 無時間戳行過濾（≥3 行帶戳時視為雜訊）；時間戳值域驗證（分/秒<60、0~360000、
    end≤start 丟棄 end）
  - 輸入護欄：行數＋單行 ≤1000 字＋總長 ≤200KB（超限 400）；內部軟時限 20s（超時回
    400 帶已處理行數，不進 APIGW 504 重試迴圈）；Lambda timeout 29s、MemorySize 1769
  - 效能：查詢變體去重＋每請求記憶化（2026-08-14，~1.9x）
- 環境變數：`BERRY_SITE_API_URL`（指向主站 API）
- 部署：push 自動（CI `deploy-matcher` job）；手動 `sam build && sam deploy` 亦可（獨立 SAM stack）
- 測試：`node test-fix.mjs` / `test-regression.mjs` / `test-history.mjs [N]` / `verify-corrections.mjs`
  （連 production API 唯讀；改 matcher 後四支都要綠）

### 歌單解析防護（src/utils/data-processor.js）

- **解析時機**：直播未結束不解析；結束後 6h 內只認 `@KL-gr1my`（cooldown，留言索引延遲 20~30 分）；
  上傳影片直接開放。手動 `/trigger-setlist-parse?force=true` 可 bypass cooldown＋全部防線
- **挑留言三層**：KL ≥3 戳（多篇按時間戳合併）→ ≥5 戳且帶戳行佔比 ≥0.5（擋逐曲感想）→ 關鍵字＋≥2 戳
- **熔斷**：fuzzy 結果 >50% 無法匹配（≥3 行）整場放棄，防垃圾入庫（2026-07-10 由 ≥5 收緊）
- **無戳防線**（2026-07-10）：無時間戳的未匹配行不建新曲（6/15 名言留言 4 行繞過熔斷事件）；
  matcher 端純括號註記行（「25:04 (big dream)」型）直接跳過
- **攔截可觀測**：熔斷/無戳全滅發 Discord 通知（同場只發一次），不靜默

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

**SecurityHeadersPolicy**（ResponseHeadersPolicy）：掛在預設與 `/tb/*` behavior
（nosniff／X-Frame-Options DENY／HSTS／CSP enforce 等）。
⚠️ CSP 值必須與 `entry-worker.js` 的 CSP 常數**逐字一致**——改任一側必須同步另一側。

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
1. `npm ci` → `sam build` → `sam deploy`（Lambda + API Gateway + CloudFront + S3）
2. fansite-v2：`npm ci` → `npm run snapshot`（best-effort，`continue-on-error`，
   刻意排在 sam deploy 之後＝快照與新版 API 輸出一致）→ 以 repo 版覆蓋快照中的
   `history.md`／`changelog.json` → `npm run build`
3. Sync S3：`dist/assets/`（`--size-only`＋`immutable`）、`dist/` 頂層（`no-cache`，
   排除 assets/data）、`fansite/img/`、`fansite/pages/history.md`、`fansite/changelog.json`。
   **全程不用全域 `--delete`**（hash 資產只增不刪、img/pages 是 bucket 上的非 dist 內容）
4. 快照獨立一輪：`dist/data/` → `s3://.../data/`（`max-age=300`＋`--delete`，
   `if: steps.snapshot.outcome == 'success'`）
5. Invalidate CloudFront `/*`（1 path）
6. `deploy-matcher` job：僅 `lambda/setlist-matcher/**` 或本 workflow 變更時部署

### Cloudflare (`.github/workflows/deploy-cf.yml`)
1. fansite-v2：`npm ci` → `npm run snapshot`（best-effort）→ 覆蓋 history/changelog
   → `npm run build` → `cp -r fansite/img/. fansite-v2/dist/img/`（同源，CSP 免改）
2. 根 `npm ci` → `npx wrangler deploy`（CF 憑證只注入這一步，不放頂層 env）
3. `wrangler.toml` 的 `[assets] directory` 指向 `fansite-v2/dist`（Vite hash 檔名，
   無 cache-bust sed 步驟）

### Secrets

見 README.md。

---

## 本地開發

```bash
# CF 路徑（含靜態檔案 + API）
npm run dev                    # wrangler dev → http://localhost:8787

# Node 路徑（含靜態檔案 + API；唯一能本地連 DB 的路徑——workerd 連不上自簽 TLS DB）
# 先開 tunnel：ssh -N -L 13307:127.0.0.1:8081 rsshub.kat-ani.win
DB_HOST=127.0.0.1 DB_PORT=13307 DB_NAME=mbdb_test node entry-dev.js   # → http://localhost:8788

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

### Meta ETag（⚠️ ETAG_VERSION 紀律）
- setlist/songlist/streamlist 的 GET 全量端點以「三表 COUNT + MAX(updatedAt)」生成 ETag
  （`src/utils/cache.js`），304 路徑不查全量；正確性依賴 `updatedAt` 為
  `ON UPDATE CURRENT_TIMESTAMP(6)`（2026-07-24 已實測，`scripts/verify-timestamp-semantics.cjs`）
- **任何改變 API 輸出形狀的修改（setlist VIEW 定義、SELECT 欄位增減、格式轉換、
  manifest 語意）都必須 bump `ETAG_VERSION` 對應項**，否則帶舊 ETag 的客戶端
  會一直拿 304 看不到新格式
- 回填／維護腳本**禁止**：顯式 `SET updatedAt = 舊值`（抑制自動刷新）、寫入 `updatedAt = NULL`
  （欄位 nullable）、TRUNCATE 後重灌保留原 updatedAt 的 dump——三者都讓變更對 ETag 隱形。
  大量修改後最保險的做法：任挑一筆 row 觸碰一下（如 `UPDATE ... SET note=note` 不行——值沒變
  不刷新；要 `SET updatedAt=CURRENT_TIMESTAMP(6)`）強制推進 MAX
- Hyperdrive 的 **query cache 必須保持關閉**——重開會讓 meta 查詢命中快取、產生 TTL 窗口的
  stale 304（與上方 Hyperdrive 節的既有規則同源，但這裡是正確性依賴不只是新鮮度）
- setlist VIEW 欄位清單已自動摻入 ETag（ALTER VIEW 增減欄位免 bump）；欄位不變、
  格式變（如 mysqlToISO8601 修改）仍需人工 bump
- setlist 前端為月度快取（IndexedDB，每月一筆 record＋meta）：manifest 比對 → 只重抓
  指紋變更的月份；不留檔場（佔位 streamID、time NULL）走 `none` bucket；快取不完整
  （缺月 record）時 etag 回 null 停用 If-None-Match——帶舊 etag 會 304 短路擋死自癒路徑

### Select2 IME
- 使用 **4.1.0**（2026-08-08 起；此前鎖 4.1.0-rc.0 五年）。4.0.13 的組字 bug 是底線，
  任何版本變動都必須人工重測日文輸入（組字 Enter 兩段式、multiple textarea、Tab 行為）
- cell editor 的 destroy 必須 defer（tool.js select2 editor 註解）：4.1.0 clear 流程
  在 change 後還會 toggleDropdown，同步 destroy 會拋 dataAdapter null

### DB 連線
- `database.js` 的 `ping()` 有 3 秒 timeout 保護
- CF Workers TCP socket 行為跟 Node.js 不同，壞連線不會自動偵測
- TLS 加密已啟用（自簽憑證，有效至 2036 年），`root@%` 強制 SSL
- Lambda 直連用 `ssl: { rejectUnauthorized: false }`，Hyperdrive 自動處理 TLS

### Setlist Composite Key
- 路由：`/api/setlist/:streamID/:segmentNo/:trackNo`
- 新增 row 用 `_isNew` flag 區分 POST/PUT

### PubSubHubbub 訂閱
- Lease 5 天，由 `runAutoUpdate` 每 4 天自動續訂（自動帶 `hub.secret`=TRIGGER_TOKEN）
- webhook 安全：GET 驗 `hub.mode=subscribe`＋topic 頻道白名單（拒外人注銷）；
  POST 驗 `X-Hub-Signature` HMAC-SHA1（**無簽名一律拒絕**；2026-06-13 全訂閱已帶 secret）
- Lambda 上 POST 通知改 async self-invoke（立即回 200，防 hub timeout 重試重複處理）
- **DNS 切換、長時間中斷後必須手動重新訂閱**（lease 過期 + callback 不可達 = 訂閱失效）
- 手動訂閱指令（記得補 `hub.secret`，值同 TRIGGER_TOKEN）：
  ```bash
  for CH in UC7A7bGRVdIwo93nqnA3x-OQ UCBOGwPeBtaPRU59j8jshdjQ UC2cgr_UtYukapRUt404In-A; do
    curl -X POST https://pubsubhubbub.appspot.com/subscribe \
      -d "hub.callback=https://m-b.win/webhook/youtube&hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=$CH&hub.verify=async&hub.mode=subscribe&hub.lease_seconds=432000&hub.secret=$TRIGGER_TOKEN"
  done
  ```
- 驗證：log 應出現 `GET /webhook/youtube?hub.challenge=...` 回應 200

### 部署
- **AWS / CF**：push 到 GitHub 自動部署
- **Lambda matcher**：push 自動部署（deploy.yml 的 `deploy-matcher` job，
  僅在 `lambda/setlist-matcher/**` 或 workflow 變更時執行）；本地 `sam deploy` 仍可用

### Lambda 保溫（EventBridge Keep-Warm）
- EventBridge Rule 每 5 分鐘觸發 Lambda `/health`
- 避免 cold start（首次請求延遲 ~400ms-5s）
- 完全在免費額度內（8,640 次/月 << 100 萬次免費）
- 設定在 `template.yaml` 的 `WarmUpRule` 資源

### 費用
- 全部在 AWS/CF 免費額度內（預估 < $0.20/月）
- EventBridge 保溫：免費
- Analytics 全在瀏覽器端（sql.js + 既有快取），無任何查詢類 API／AI 成本

---

## 版本歷史

| 版本 | 日期 | 主要更新 |
|------|------|----------|
| v3.10 | 2026-08-13 | 新增「音樂作品」（Discography）頁（v3/fansite-v2）：專輯 10・單曲 11・客座 9 的封面牆＋詳細面板（曲目/staff/特設・BOOTH・配信・XFD 連結/instrumental 註記），曲目 🎤N 鈕就地展開歌枠演唱場次（帶 ?t= 秒數）、`/setlist?song=` 跳轉；封面圖 `fansite/img/albums/`（隨 CI 上線）；dev 圖片改 vite middleware 直讀本地 `fansite/img`；資料權威序＝官方 discography 頁＞BOOTH＞特設頁＞iTunes＞wiki（wiki 累計漏曲 5 處不採信） |
| v3.9 | 2026-08-09 | 表格快速搜尋語法（由 fansite-v2 移植）：四張表頁的進階搜尋卡片首列新增快速搜尋框，支援 `欄位:值`（三語別名表）、引號值、全形冒號／空白／彎引號、`欄位:*`＝非空、空白分隔 AND；認不得的欄位名整串退回全文比對（`12:34` 不誤拆）；「?」語法說明面板（三語＋可點擊套用的範例）；與既有多欄運算子搜尋並存（統一 `applyTableFilters()` 出口合併送 `setFilter`），刪空搜尋框不再誤清 headerFilter |
| v3.8 | 2026-08-09 | Analytics 重寫（由 fansite-v2 移植）：新增統計面板（統計卡＋Top20 曲／Top10 歌手／24 月趨勢，純 JS 聚合既有快取、毫秒級零下載）＋自繪 SVG 圖表；查詢改「選取式建構器」（值全 bind、LIKE 加 ESCAPE）；進階 SQL 引擎 DuckDB-WASM→self-host sql.js；**text-to-sql（AI SQL 助手）全鏈移除**（前端 modal／`/api/text-to-sql`／預算控制／`ANTHROPIC_API_KEY`）；parquet 管線退役 ⇒ CSP 兩側移除 cdn.jsdelivr.net、sqldata.m-b.win，worker-src 收回 'self' |
| v3.7 | 2026-08-09 | CDN 靜態快照資料層（由 fansite-v2 移植）：首訪改「IDB → /data/*.json 快照 → API 增量校正」三層瀑布，setlist 首訪由三段式 API 抓取（4 發、秒級）降為快照灌入＋僅重抓指紋變更的月份；快照由 `npm run snapshot` 於 CI 產生，AWS 側 max-age=300 獨立同步、CF 側隨 Static Assets 上傳；快照缺席無縫 fallback 原 API 路徑 |
| v3.6 | 2026-08-08 | 苺咲べりぃ主題色上線：Bootstrap 改 SCSS 客製編譯（bootstrap-berry.scss，官方 Sass 變數路線），亮=草莓牛奶（預設）／暗=暗莓雙主題＋navbar 切換鈕（theme-init.js 防閃）；裝飾層 theme-berry.css（navbar 漸層線/光暈/h2 hairline/表頭底線）；硬編暗色 class 清理（btn-outline-light、bg-dark modal），色碼取樣自官方 logo・symbol |
| v3.5 | 2026-08-05 | 表格快取遷移 IndexedDB：拆掉 localStorage 壓縮機械（5MB 配額爆掉與壓縮卡頓根治，淨刪 92 行）、setlist 每月一筆 record 增量寫入、缺月快取自癒、IDB 不可用降級直抓 API |
| v3.4 | 2026-07-25 | 安全強化第二輪（批次 A~E 全量上線）：全域錯誤處理集中化＋錯誤回應泛化、CSP 兩側正式 enforce＋/tb/* security headers、matcher 輸入護欄＋timeout 29s、三頁 inline script 外抽、AI 預算原子化、CI matcher 部署偵測修正（改比對 push 全範圍） |
| v3.3 | 2026-06-13 | 歌單辨識大修：挑留言防護（cooldown/佔比/熔斷）、matcher 精度（序號感知/EN 欄位/格式解析）、alias 綁 songID、webhook 驗證＋非同步化 |
| v3.2 | 2026-03-22 | 安全強化：CORS、rate limiting、security headers、DB TLS |
| v3.1 | 2026-03-21 | SPA 路由白名單、縮圖 S3 存儲、Polling 10 分鐘、CloudFront 存取日誌 |
| v3.0 | 2026-03-18 | AWS 遷移完成：CloudFront + Lambda + S3、CI/CD、舊 Workers 停用 |
| v2.9 | 2026-02-26 | PubSub 直播時間修正 |
| v2.8 | 2026-01-20 | Analytics SQL 小幫手 |
| v2.7 | 2025-12-29 | 多語言優化、GitHub commit 代理 |

**最後更新**：2026-08-13
