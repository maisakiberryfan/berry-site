# fansite-v2 設計規格

> 苺咲べりぃ非官方粉絲站「砍掉重做」版。本文件是所有實作的統一依據。
> 後端 API **完全沿用不動**；重做的只有前端。部署仍為純靜態（S3+CloudFront / CF Workers Static Assets）。

## 目標（驗收標準）

1. **資料讀取比現站快**：首訪資料就緒 <0.5s（現站 setlist 全量 TTFB 3.7s）、回訪 IndexedDB 毫秒級
2. **版面乾淨不雜亂**：編輯入口收斂成 drawer、工具列極簡、大量留白
3. **wiki 概念**：任何人都可編輯（沿用現有無 auth 的編輯 API）
4. 三語（zh/en/ja）＋草莓亮暗雙主題完整保留

## 技術棧

- Vite 7 + Svelte 5（runes：`$state`/`$derived`/`$effect`）、SPA
- Tailwind CSS 4（`@tailwindcss/vite`，dark variant 走 `[data-theme='dark']`，見 app.css）
- idb-keyval（IndexedDB）
- **不用** jQuery/Bootstrap/Tabulator/Select2/DuckDB。表格、下拉、圖表全部自寫。
  analytics 自由 SQL 用 sql.js（SQLite wasm self-host、lazy），資料源＝瀏覽器快取。
- 基準 bundle 9.89KB gzip，完成後目標 <80KB gzip（不含資料）

## 資料層（速度勝負手）— src/api/

讀取三層瀑布，UI 永遠先渲染可用資料再背景校正：

1. **IndexedDB**（回訪）：立即渲染
2. **CDN 快照**（首訪）：`/data/songlist.json`、`/data/streamlist.json`、`/data/setlist-YYYY-MM.json`、`/data/manifest.json`
   - build 時由 `scripts/fetch-snapshot.mjs` 從 API 抓生成（正式上線後改 cron 刷新，本階段 build 產生即可）
   - 靜態檔走 CDN edge + 壓縮，首訪 <0.5s
3. **API 背景增量校正**：
   - setlist：抓 `/api/setlist/manifest` 與本地快取比對，只重抓指紋（count+maxUpdated）變更的月份（`?from=YYYY-MM&to=YYYY-MM`；`from=none` 為不留檔場 bucket）
   - songlist/streamlist：帶 If-None-Match（meta ETag），304 即跳過
   - 校正後更新 IDB ＋ 響應式更新 UI
4. **編輯後**：寫 API 成功 → 直接更新記憶體資料與 IDB（不等重抓）

⚠️ 規則：快取不完整（缺月）時不得帶舊 ETag（會 304 短路擋死自癒）——沿用現站教訓。
IDB 不可用（私密視窗等）→ 降級：快照 + API 直抓，不炸。

## 版面設計原則

- 極簡：單一主色（草莓紅）點綴、hairline 邊框、充分留白、系統字型堆疊
- navbar：品牌名＋少量分組連結＋右側「語言切換、主題切換」兩顆 icon 鈕。手機收 hamburger
- 列表頁：頂部一條工具列（搜尋框＋必要篩選 chip）→ 表格本體乾淨（無內嵌編輯格）
- **編輯 = 點列尾鉛筆 icon → 右側 drawer 表單**（新增 = 工具列「＋」鈕 → 同一 drawer）。行內不做編輯
- 響應式：≥768px 表格、<768px 卡片式列
- 亮暗主題全部走 CSS custom properties（tokens 見 app.css），**禁止**硬編亮/暗前提色

## 頁面清單（router 路徑沿用現站，SPA rewrite 白名單不變）

| 路徑 | 內容 | 資料 |
|------|------|------|
| `/` | hero（最新影片/直播狀態）＋各區入口卡片 | `/api/yt/latest`＋快取表 |
| `/songlist` | 歌曲表（搜尋/排序/篩選）＋wiki 編輯 | songlist |
| `/streamlist` | 直播表（縮圖 `/tb/{id}.jpg`、fallback YT CDN）＋wiki 編輯 | streamlist |
| `/setlist` | 歌單表（月度快取、YTLink 帶 t=秒）＋wiki 編輯 | setlist（月度） |
| `/aliases` | 別名管理（title 綁 songID / artist 字串）＋wiki 編輯 | aliases |
| `/analytics` | 統計卡片＋自繪 SVG 圖表（客端 JS 聚合，毫秒級） | 既有快取資料 |
| `/profile` | 個人資料（搬運） | 靜態 |
| `/history` | 沿革（markdown 渲染，來源同現站） | 靜態 |
| `/clothes` | 衣裝（搬運，圖片沿用 fansite/img/） | 靜態 |

## i18n（src/i18n.js）

- 語言偵測與 localStorage key **沿用現站**（key 名見 SPEC-frontend.md）
- 字典模組化：`src/i18n/{zh,en,ja}.js`，Svelte 5 reactive（`$state` 單例 store）
- nav 資料沿用 label/labelEn/labelJa 模式

## 主題

- `public/theme-init.js` head 同步防閃（已寫好），localStorage key 沿用現站
- 色票以 SPEC-frontend.md 的現站取樣為準（app.css tokens 校正）

## API 契約

見 SPEC-api.md（Explore 彙整）。注意回應為 `{"data": ...}` 包裝。

## 實測基準（2026-08-08，production）

| 端點 | 傳輸大小 | TTFB |
|------|---------|------|
| /api/songlist.json | 32KB | 0.71s |
| /api/streamlist | 57KB | 0.76s |
| /api/setlist（全量） | 791KB | **3.70s** ← 現站首訪痛點 |
| /api/setlist?from=2026-07&to=2026-07 | 12KB | 0.24s |
| /api/setlist/manifest | 869B | 0.48s |

（API 無 gzip 壓縮；靜態快照走 CloudFront 自動壓縮，另賺一段傳輸時間）

## 檔案結構

```
fansite-v2/
├── index.html / public/theme-init.js（已寫好）
├── vite.config.js（/api、/tb 代理 → BERRY_API 或 https://m-b.win）
├── scripts/fetch-snapshot.mjs（快照生成 → public/data/）
├── src/
│   ├── main.js / App.svelte / app.css（tokens）
│   ├── router.js（history API，極簡自寫）
│   ├── i18n.js + i18n/{zh,en,ja}.js
│   ├── theme.js（切換鈕邏輯）
│   ├── api/（client.js、store.js＝三層瀑布＋IDB）
│   ├── lib/（DataTable.svelte、Drawer.svelte、SearchBox.svelte、Chart 元件…）
│   └── pages/（Home、SongList、StreamList、SetList、Aliases、Analytics、Profile、History、Clothes）
```

## 禁區

- 不碰 `fansite/`（現站）與 `src/`（後端）的任何檔案
- 不 commit、不 push（用戶審閱後決定）
- 編輯功能本地測試一律接測試 DB（dev:testdb 模式），**不可對 production 寫入**
