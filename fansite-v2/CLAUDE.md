# fansite-v2（v3 站）維護手冊

> 本檔供接手維護的 Claude Code 使用。專案總體規範見 repo 根 `CLAUDE.md`（後端／部署／DB 紀律都在那），本檔只講 v3 前端。
> 版本脈絡：v1＝最初靜態 JSON 版 → v2＝`fansite/`（jQuery+Bootstrap+Tabulator，現行主站）→ **v3＝本目錄**（2026-08 重寫，社群評估中；用戶已裁示「以 v3 介面為主」，v2 前端將退場）。

## 技術棧與指令

Vite 7 + Svelte 5（**runes**：$state/$derived/$effect）+ Tailwind 4 + idb-keyval。無 jQuery/Bootstrap/Tabulator/Select2/DuckDB——表格、下拉、圖表、lightbox、選單全部自寫在 `src/lib/`。

```bash
npm run dev          # :5173，/api 代理 production（唯讀瀏覽安全；「編輯送出」會寫正式庫，測試勿按儲存）
npm run dev:testdb   # :5175，/api 代理本地後端 8788（entry-dev.js + 測試庫）——測編輯用這個
npm run snapshot     # 從 production API 抓資料快照 → public/data/（build 前要跑）
npm run build        # 純靜態產物 → dist/
```

v3 demo 站部署（獨立 CloudFront，與 git 無關）：
```bash
VITE_ASSET_BASE=https://m-b.win npm run build
aws s3 sync dist/ s3://berry-fansite-v3-495219733379/ --delete
aws cloudfront create-invalidation --distribution-id E1ZENENQETM5MD --paths "/assets/*" "/index.html"
```
（demo 站 v3.m-b.win：distribution E1ZENENQETM5MD、/api/* 直通主站同一 API Gateway、SPA rewrite 用獨立 function `berry-v3-spa-rewrite`。上線切換的 TODO 見 README.md）

## 架構關鍵

### 資料層（src/api/）——速度的核心，動它前先讀 store.svelte.js 檔頭
三層瀑布：**IndexedDB（回訪秒開）→ CDN 快照 /data/*.json（首訪）→ API 背景增量校正**。
- songlist/streamlist：ETag 304 校驗；setlist：manifest 指紋比對只重抓變更月份
- **缺月時 manifest 請求不得帶舊 ETag**（304 會短路自癒——現站踩過的坑）
- store 介面統一：`.rows`（$state.raw，**不可就地 mutate、不可解構**）、`.load()/.reload()`、寫入成功後 `applyLocal{Insert,Update,Delete}`；setlist 另有 `.months`、`.refreshMonth(m)`
- reorder 後 trackNo 重編、composite key 全變 → 一律 `refreshMonth()` 不要逐列 applyLocal
- 客端 join：`setlistJoined.rows`（補 streamTitle）、`songIndex`/`streamIndex`、`hydrateSetlistRow()`（POST 201 的裸 row 補成 VIEW 形）

### API 契約
`SPEC-api.md` 是唯一依據（三套回應信封、ETag 範圍、rate limit 30 寫入/分）。要點：POST /api/setlist 必帶 `X-Source: user`（client.js 已自動）；編輯 UI 一律「一次儲存」不做逐鍵送出；批次操作用單一陣列 POST（算 1 次限流）。

### 共用元件（src/lib/table/）
`DataTable`（虛擬滾動＋欄位篩選列＋欄寬拖拉＋行尾動作欄）、`Drawer`、`Combobox`（id-based 選取，**無自由輸入**——需要自由輸入用 TextInput+datalist，見 SongList artist 欄）、`RowMenu`（⋯＋右鍵共用選單）、`SearchBox`（欄位語法＋?說明）。介面說明都在各檔頭註解。搜尋語法引擎在 `utils.js`（tokenize/matchesQuery——欄位別名表由各頁提供）。

## 鐵則（違反過都出過事）

1. **亮暗主題**：一律 berry tokens（`--berry-*`／`bg-berry-*`），**禁止硬編亮暗前提色**；app.css 的元素選擇器要包 `@layer base`（裸規則會蓋掉 Tailwind utility）
2. **手機唯讀**（用戶裁示）：<768px（`MOBILE_MQ`）不渲染任何編輯入口（鉛筆／＋新增／歌單編輯／排序）；查閱功能（搜尋、查看歌單、KL 複製）保留
3. **IME**：任何自寫輸入元件的改動**必須處理 composition 事件**（組字中間態不觸發過濾/送出/關閉），並請用戶親測日文輸入——SearchBox/Combobox/DataTable 篩選列/TagInput 是現有範本
4. **i18n**：頁面文案用頁內 `msgs = {zh,en,ja}` 局部字典＋`getLang()`；共享字典（src/i18n/）只放跨頁共通 key。語言順序 中→日→英；localStorage key `lang`/`theme` 與 v2 互通勿改
5. **時間**：DB 存 UTC、顯示/編輯/查詢全走使用者本地時區；時間欄標籤帶 `(+08:00)`（`labelWithTz`）；setlist 的 startTime/endTime 是影片內秒數（`parseHmsToSeconds`/`secondsToHms`）
6. **搜尋別名表**：`matchesQuery` 的欄位名查找必須 `Object.hasOwn`＋`Array.isArray` 把關（原型鏈注入）
7. **寫入測試一律接測試庫**（dev:testdb）；5173 的編輯送出會寫 production；測試資料用完要還原

## 功能地圖（每頁的非顯然行為）

- **SongList**：歌手欄自動完成（本地 distinct＋datalist、選定帶日英雙欄）
- **StreamList**：RowMenu（查看歌單→`/setlist?stream=`／快速新增→`?add=`／KL 格式歌單／複製／開 YT，歌單類僅歌枠列）；新增 drawer 貼網址自動查 `/api/yt` 帶標題時間分類（手改不覆蓋；三頻道白名單外→警告＋「仍要新增」確認）
- **SetList**：編輯 drawer 四模式（edit／batch 新增／reorder 曲序／alias 快速新增別名）；`?stream=`/`?add=` query 直達；月份下拉年份分組；快速新增別名 title 模式自動綁該列 songID（防同名互染——維運核心迴路）
- **Aliases**：quick-add／test 端點接線；信封是 `{success,data}`（client 已統一解包，要 `isNew` 用 `request()` 讀 raw）
- **Analytics**：統計／資料查詢分籤（`#query` 直達）；統計＝客端 JS 聚合；查詢＝建構器（白名單＋bind 防注入）＋進階 SQL（sql.js 659KB lazy self-host）；資料源＝瀏覽器快取攤平的 `berry_data` 寬表（time/month 為本地時區）
- 全列表頁：全域搜尋（`欄位:值`／`欄位:*` 語法）∧ FilterChips ∧ 欄位篩選列，三層 AND；計數統一 cascade 語意（收斂計數、不裁選項）

## 與 main（v2）的關係

後端 `src/` 兩站共用——**改後端必須與 origin/main 逐位元對齊**（整組檔案 checkout，別挑檔案——漏過 app.js 路由註冊一次）。跨 session 協作紀錄與規格在共用記憶（`spec-setlist-reorder-api.md`、`v2-to-v3-migration-checklist.md`——移植進度在後者打勾）。CSP 若改必須 entry-worker.js 與 template.yaml 兩側逐字同步（根 CLAUDE.md 紀律）。

## 文件索引

- `README.md`——預覽方式、速度數據、上線前 TODO（快照 cron／OG meta／CF 備用站等 8 項）
- `DESIGN.md`——設計原則與驗收標準｜`SPEC-api.md`——API 契約｜`SPEC-frontend.md`——v2 現況對照
- 專案記憶 `fansite-v2-rebuild.md`——十輪審閱的完整決策史（為什麼長這樣的答案都在裡面）
