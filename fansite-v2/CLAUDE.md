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
npm run snapshot && VITE_ASSET_BASE=https://m-b.win npm run build
BUCKET=berry-fansite-v3-495219733379 DISTRIBUTION_ID=E1ZENENQETM5MD bash scripts/deploy-sync.sh
```
（demo 站 v3.m-b.win：distribution E1ZENENQETM5MD、/api/* 直通主站同一 API Gateway、SPA rewrite 用獨立 function `berry-v3-spa-rewrite`。上線切換的 TODO 見 README.md）

**`scripts/deploy-sync.sh` 取代了裸 `aws s3 sync --delete`**——後者會在部署當下刪光舊
hash chunk，開著舊分頁的人 lazy-load（QueryPanel、sql.js wasm）就吃 404。腳本五步，
上傳順序 **資產 → 資料 → index.html** 是刻意的（入口最後換，避免它指向還沒上傳的資產）：

1. `dist/assets/` **不帶 --delete**，hash 資產只增不刪
2. `dist/data/` 帶 `--delete` 清過期月度快照（本地端 fetch-snapshot.mjs 已先清過），
   並帶 `--cache-control "public, max-age=300"`——**與後端快照 cron
   （`src/cron-jobs/snapshot.js`）寫同一批 key 的值一致**，不然兩邊會讓同一支檔案的快取飄移
3. 其餘根層檔（index.html／favicon／theme-init.js）帶 `--delete --exclude "assets/*"
   --exclude "data/*"`——exclude 同時作用於目的地，assets/ 因此不受 --delete 影響，
   保留窗口就靠這一點成立
4. 回收孤兒 hash 資產：本地已無 ∧ LastModified 早於 `RETENTION_DAYS`（預設 14）天才刪；
   此步失敗不讓部署判失敗（檔案已同步完成，下次再收）
5. invalidation 只清 `/index.html` 與 `/data/*`——**hash 資產免清**（檔名含內容 hash，
   內容變＝URL 變，同 URL 的邊緣快取永遠正確；舊命令的 `"/assets/*"` 是白花額度）

`DRY_RUN=1` 可安全空跑（sync 走 `--dryrun`、刪除與 invalidation 只列印）。
⚠️ 若日後把 `/img`、`/pages` 等現站靜態資源搬進同一 bucket，必須讓它們進 `dist/`
或在步驟 2 加 `--exclude`，否則會被 `--delete` 清掉。

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
- **SetList**：編輯 drawer 四模式（edit／batch 新增／reorder 曲序／alias 快速新增別名）；
  batch 草稿列有「開始／結束時間」欄（與單列編輯共用 `parseHmsToSeconds`，範圍 0~360000 擋在前端，
  一列格式錯就整批不送）：**批次＝所見即所得的整段狀態替換**（用戶裁示 2026-08-14）——
  payload 每列一律帶齊 songID/note/startTime/endTime，空欄送 `null`＝清空既有值
  （後端 ON DUPLICATE 四欄全 `VALUES(x)` 無條件覆寫，沒有 COALESCE 保護）。
  **例外是曲目**：`setlist_ori.songID` 為 NOT NULL＋FK，沒有「清空」這回事，未選曲的列會讓
  整批 INSERT 在 DB 層失敗 ⇒ 送出前驗證每列必選曲，未選的列 Combobox 標紅＋訊息點名曲序
  （與時間格式驗證同一套 `draftErrors` 呈現，兩類同時發生就兩句一起顯示）。
  **防丟資料全靠 prefill**：草稿列撞到既有 trackNo 時整列帶入既有的曲目／時間戳／備註進 value，
  並在曲序下標「既有」提示這列是覆寫（全空的既有列光看欄位分辨不出來）；時間欄刻意不給
  placeholder（空欄＝清空，灰字舊值會誤導成保留）。**對位一變就整批重灌**：場次／段落／起始曲序
  任一改動都重新編號並重新 prefill（未送出的輸入會被捨棄——舊輸入對新對位已失義，留著會被
  當成「這列現在的內容」寫進別列）；送出後本地狀態以回應的 `entries`（DB 真值）為準；
  reorder 面板有「依時間戳排序」鈕（有戳列升冪填回原位、無戳列不動）＋時間戳矛盾即時警告
  （不阻擋儲存）——不變量：trackNo 順序 ≡ 時間戳順序；`?stream=`/`?add=`/`?songID=`/`?song=`
  query 直達（**`?songID=` 是 Discography 導來的正路**：對 songID 精確等值過濾，與搜尋框／
  欄位篩選 AND 疊加，並在工具列下方出 chip 可清除；`?song=` 是曲名字串的退路，SetList 端組成
  `曲名:"…"` 語法字串走子字串比對——同名異曲會互染，只在沒有 songID 時才用）；月份下拉年份分組；快速新增別名 title 模式自動綁該列 songID（防同名互染——維運核心迴路）
- **Aliases**：quick-add／test 端點接線；信封是 `{success,data}`（client 已統一解包，要 `isNew` 用 `request()` 讀 raw）
- **Analytics**：統計／資料查詢分籤（`#query` 直達）；統計＝客端 JS 聚合；查詢＝建構器（白名單＋bind 防注入）＋進階 SQL（sql.js 659KB lazy self-host）；資料源＝瀏覽器快取攤平的 `berry_data` 寬表（time/month 為本地時區）
- **Discography**：單頁三分節（專輯／單曲封面牆＋客座列表）＋點卡開詳細面板（`#<id>` hash 直達，
  開關面板走 `navigate()` 而非裸 replaceState——面板狀態綁 `route.hash`，導覽列點同頁才關得掉）；
  **setlist／streamlist 延到第一次開面板才載**（封面牆只要 songlist），骨架由 `load()` promise
  完成時機收掉、空資料顯示「無演唱紀錄」；曲目的 🎤N 鈕就地展開該曲的 setlist 場次
  （客端 songID 索引建在 `setlist.rows`，場次標題展開時才 `streamTitleOf()`，連結帶 `?t=` 秒數，
  最多 20 場），尾端「在歌單中查看」導 `/setlist?songID=<id>`（精確等值，不再用曲名字串以免
  同名異曲互染）；曲名一律以 songlist 為準，
  `discographyData.js` 的 name 只是 fallback（songID 為 null＝未唱過，不顯示 🎤）；
  封面 `/img/albums/{id}.webp`（源：repo `fansite/img/albums/`，dev 由 vite middleware
  直接讀本地）缺圖時走主題色漸層佔位；links.stream＝配信聚合頁、links.xfd 與
  track.youtube 存 YouTube videoId（來源 streamlist DB）；instrumental 版不逐軌列、
  面板尾一行註記（資料權威序見 discographyData.js 檔頭——官方 disco 頁＞BOOTH＞特設頁
  ＞iTunes＞wiki，wiki 有漏曲前科勿直接採信）
- 全列表頁：全域搜尋（`欄位:值`／`欄位:*` 語法）∧ FilterChips ∧ 欄位篩選列，三層 AND；計數統一 cascade 語意（收斂計數、不裁選項）

## 與 main（v2）的關係

後端 `src/` 兩站共用——**改後端必須與 origin/main 逐位元對齊**（整組檔案 checkout，別挑檔案——漏過 app.js 路由註冊一次）。跨 session 協作紀錄與規格在共用記憶（`spec-setlist-reorder-api.md`、`v2-to-v3-migration-checklist.md`——移植進度在後者打勾）。CSP 若改必須 entry-worker.js 與 template.yaml 兩側逐字同步（根 CLAUDE.md 紀律）。

## 文件索引

- `README.md`——預覽方式、速度數據、上線前 TODO（快照 cron／OG meta／CF 備用站等 8 項）
- `DESIGN.md`——設計原則與驗收標準｜`SPEC-api.md`——API 契約｜`SPEC-frontend.md`——v2 現況對照
- 專案記憶 `fansite-v2-rebuild.md`——十輪審閱的完整決策史（為什麼長這樣的答案都在裡面）
