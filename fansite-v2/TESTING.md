# fansite-v2（v3）功能測試指南

> 給「之後建測試」的接手 session。**逐功能列出：預期行為、邊界、驗證點、建議測試層級**。
> 由主 session 於 v3 完工時（context 用盡前）趁記憶新鮮寫下，避免冷啟動補不出行為細節。
> 測試層級標記：〔U〕純函式單元、〔C〕元件、〔I〕整合（接測試 DB）、〔E〕端到端瀏覽器。
> ⚠️ 寫入類測試一律接測試庫（`npm run dev:testdb` / 本地後端 8788），**絕不對 production 寫入**。

---

## 1. 資料層（src/api/store.svelte.js、client.js）— 最該有測試的一塊

### 1.1 client.js 信封解包〔U〕
三套回應信封統一解包（見 SPEC-api.md §0）：
- `{data}`（songlist/streamlist/setlist）→ 回 data
- `{success,data,count,isNew}`（aliases）→ 回 data；`success:false` → throw ApiError
- `{success,data}`／`{success,error:字串}`（stats、yt/latest）
- 邊界：`success:false` 轉 throw、網路錯誤重試（3 次遞增 delay）、4xx **不**重試、5xx 重試
- POST `/api/setlist` 自動帶 `X-Source: user` header；其他端點不帶
- GET 帶 If-None-Match → 回 `{data, etag, notModified}`
- **已有 13 項契約測試的前例**（scaffold 階段寫過、跑完刪；可重建為常駐）

### 1.2 三層瀑布〔I〕
IndexedDB → CDN 快照 `/data/*.json` → API 背景校正。測試點：
- 回訪（IDB 有資料）：立即渲染舊資料，不等 API
- 首訪（IDB 空）：快照命中先渲染，背景 API 校正後更新
- songlist/streamlist：帶 ETag，304 → 沿用；200 → 整包替換＋更新 IDB
- **缺月自癒**（關鍵回歸點）：setlist 快取缺某月時，manifest 請求**不得帶舊 ETag**（帶了會 304 短路、缺月永遠補不回）。測法：清掉一個 `setlist:m:YYYY-MM` key，再同步應重抓該月
- **API 回非陣列保護**：sync 收到 200 但 body 非陣列（如 SPA HTML fallback）→ 保留現有資料、不覆寫快取為 []
- **IDB 掛住降級**：cacheGet 有 2s timeout，逾時→標 IDB 不可用、走快照+API、不卡死瀑布

### 1.3 setlist 月度快取〔U/I〕
- manifest 指紋 = version + count + maxUpdated（當不透明字串，勿 parse）
- 只重抓指紋變更的月份；none bucket 走 `from=none`
- 扁平化顯示序：月份 key 降序、none 殿後、月內依 API 順序
- reorder/編輯後：`refreshMonth(month)` 整月重抓（trackNo 重編後 composite key 全變，不可逐列 applyLocal）
- `rows` 是 `$state.raw`：不可就地 mutate、不可解構 store

---

## 2. 搜尋與篩選（src/lib/table/utils.js）— 純函式，最好測

### 2.1 tokenize / matchesQuery〔U〕
- `苺咲 anisong`：空白分隔 AND 全文
- `"hello world"`：引號括含空白詞
- `歌手:ヨルシカ`：欄位限定（別名表查 field）
- `歌手:"苺咲 べりぃ"`：欄位限定＋含空白值
- 全形冒號`：`、全形空白、彎引號`" "` 都要吃
- `12:34`：欄位名 `12` 認不得 → 整 token 退回全文（**不可誤拆**）
- `歌手:`（值空）：不套條件（否則瞬間 0 筆）
- `備註:*` / `備註:＊`：該欄不為空
- **原型鏈防護**（安全回歸點）：`constructor:x`/`tostring:x`/`__proto__:x`/`hasownproperty:x` 必須 REJECT（Object.hasOwn+Array.isArray 把關），不可拋 not iterable
- 各頁別名表見各 page 的 SEARCH_ALIASES（中英日 key）

### 2.2 欄位篩選 compileColumnFilters / matchesColumnFilters / countDistinct〔U〕
- text 欄 contains（大小寫不敏感）；select 與 filterExact 精確比對；陣列欄（categories）包含判定
- 空條件回 null（呼叫端跳過整輪）
- cascade 計數：countDistinct 對「其他條件篩選後」的 rows 算，選項不裁、只更新 count
- 段/曲序用 filterExact（打「1」不撈出 1x/x1）

### 2.3 排序 applySort / nextSort〔U〕
- 欄頭循環 none→asc→desc→none
- 空值恆殿後（不隨升降序翻面）
- Intl.Collator numeric 比較

---

## 3. 格式化與解析（utils.js）〔U〕— 便宜高價值

- `parseHmsToSeconds`：`1:23:45`→5025、`23:45`→1425、`5025`→5025、``→null、`1:2:3`/`abc`/`25:99`→NaN（8 案例前例已驗）
- `secondsToHms`：秒→h:mm:ss / m:ss
- `formatDate`/`formatDateTime`：ISO(UTC)→本地時區字串
- `toDatetimeLocalValue`/`fromDatetimeLocalValue`：**round-trip 無損**（UTC↔本地↔UTC，時區測試關鍵）
- `tzLabel`：offset→`+08:00`/`-05:30`
- `parseYouTubeId`：watch/youtu.be/live/shorts/embed/裸 ID；**長度護欄 >300 回 null**（安全，擋 O(n²)）
- `csvCell`（安全）：公式起手字元（`=+-@` tab CR LF）前置 `'`；含 `",\r\n` 用雙引號包＋內部 `"`→`""`
- `safeHref`（markdown.js）：只放行 `https?://` 與 `/` 開頭，擋 `javascript:`/`data:`

---

## 4. 各頁功能〔E〕

### 4.1 SongList
- 曲名/歌手雙語兩行顯示；genre select 篩選
- 歌手欄自動完成（datalist、本地 distinct、選定帶日英雙欄、手打英文名不被覆寫）
- CRUD：新增 POST／編輯 PUT `/:songID`／刪除 DELETE（409 被引用→友善訊息）

### 4.2 StreamList
- 縮圖 `/tb/{id}.jpg`→error fallback `i.ytimg.com`（once，防迴圈）
- RowMenu（⋯＋桌面右鍵同一選單）：查看歌單（→`/setlist?stream=`）、快速新增歌單（→`?add=`）、KL 格式歌單、複製網址、開 YT——歌單類僅歌枠列（categories 含 歌枠/singing/karaoke）
- 有選取文字時右鍵放行原生選單（不攔截）
- 新增 drawer：貼網址自動查 `/api/yt` 帶標題/時間/分類；手改欄位不覆蓋；三頻道白名單外→警告＋「仍要新增」確認（非硬阻）；查詢失敗降級手填；items 空（影片下架）→「找不到」提示

### 4.3 SetList（核心）
- 場次欄日期＋streamTitle（via setlistJoined）、safeYTLink 帶 t=秒
- 編輯 drawer 四模式：edit（選歌 Combobox＋note＋startTime/endTime）、batch（新增場次）、reorder（曲序）、alias（快速新增別名）
- `?stream=`/`?add=`/`?edit=` query 直達
- **reorder**〔I〕：↑↓/拖曳排序→一鍵送出 `PUT /:streamID/:segmentNo/reorder`（單一請求）；trackNo 重編 1..N；併發衝突 400（fieldErrors.order 帶 missing/unknown）→顯示重新載入；成功後 refreshMonth
- **快速新增別名**：title 模式自動綁該列 songID、可「改選其他歌曲」；artist 模式掛 442 歌手 datalist；別名=正名防呆；連續新增
- 批次新增：貼網址解析 streamID→N 草稿列→單一陣列 POST（rate limit 算 1 次）
- 月份下拉年份分組（optgroup）

### 4.4 Aliases
- quick-add（title 綁 songID）、test（`/api/aliases/test`）
- 信封 `{success,data,isNew}`：要 isNew 用 request() 讀 raw

### 4.5 Analytics
- 統計/資料查詢分籤（`#query` 直達，hash 同步）
- 統計：客端 JS 聚合（TOP20、月度趨勢、歌手排行）；月度分桶用**本地時區**（與查詢寬表 month 同語意）
- 查詢建構器：欄位勾選＋條件（運算子依型別）＋分組聚合（6 種，數值欄才開放平均/總和等）＋排序＋筆數；SQL 預覽
- 進階 SQL：sql.js（SQLite wasm 659KB lazy self-host）；`berry_data` 寬表；time/month 本地時區
- **安全〔I〕**：欄位/運算子/聚合白名單、值全 `stmt.bind()`；注入案例（`'; DROP TABLE`、`%`/`_`/`'` LIKE 跳脫）必須無害——**19 案例前例已驗**

### 4.6 Home / 靜態頁
- Home：hero 最新影片卡（ytLatest，時區標記）、入口卡片筆數、最近更新（changelog）、資料來源（YouTube 留言＋兩 wiki）
- History：`/data/history.md`（快照）自寫 markdown 渲染（**無 {@html}**，逐 token）；年份 sticky nav
- Clothes：16 套 clothesData、2D/3D 篩選、自寫 Lightbox、hash 直達 `#YYYYMMDD`/`-N`
- Profile：facts（出道時長即時算）、BGM 播放器、三語自介

---

## 5. 跨頁行為〔C/E〕

- **i18n**：localStorage key `lang`、偵測順序（stored→navigator→zh）、語言順序中→日→英；切換時 `<html lang>`＋meta description 跟著換；pickLabel 三語 fallback
- **主題**：key `theme`、theme-init.js 首繪防閃（?theme= override 不落地）；全走 berry tokens；app.css 裸選擇器包 @layer base（否則蓋不過 utility）
- **手機唯讀**（鐵則 2）〔E〕：<768px（MOBILE_MQ）不渲染鉛筆/＋新增/歌單編輯/排序；查閱（搜尋/查看歌單/KL 複製）保留。**注意坑**：CSS `hidden` 會被 Button 的 inline-flex 蓋掉，必須用 `{#if !isMobile}` 條件渲染（四頁）
- **IME**（鐵則 3）〔E，需真人〕：Combobox/SearchBox/欄位篩選/TagInput 組字中不觸發過濾/送出/關閉；Combobox 選歌兩段式 Enter（先確定假名、再選定）；組字中 Esc 只取消組字不關 drawer
- **編輯 drawer**：dirty 時關閉走 discard 確認；Esc 關閉（composing/上層 alertdialog 時不關）

---

## 6. 後端（src/，兩站共用，接測試庫）〔I〕

- setlist CRUD＋reorder（高位偏移 +100000 暫存區、trackNo 重編、併發 409）
- setlist PUT 的 startTime/endTime（0~360000 整數秒或 null，越界 400）
- **rate-limit IP 來源**（安全）：cf-connecting-ip→requestContext.http.sourceIp→XFF 末段；偽造 XFF 首段**不應**繞過（第 31 次 429）；不同 XFF 末段不誤擋；GET 不受限
- month 驗證×3（fetch-snapshot 兩版＋cron）：非 `YYYY-MM`/`none` 跳過
- ETag：setlist/songlist/streamlist 全量＋manifest 支援 304；月度端點不支援

---

## 建議優先序（若時間有限）

1. **utils.js 純函式**〔U〕（§2、§3）——最便宜、最穩、回歸價值最高（搜尋語法、格式化、csvCell、原型鏈防護）
2. **client.js 信封＋重試**〔U〕（§1.1）——有前例可重建
3. **資料層瀑布＋缺月自癒**〔I〕（§1.2）——最容易回歸壞掉的一塊
4. **後端 reorder＋rate-limit**〔I〕（§6）——安全與資料完整性
5. 各頁 e2e〔E〕——成本高，挑核心流程（setlist 編輯/reorder、搜尋、手機唯讀）

測試框架未定；純函式建議 vitest（Vite 專案原生相容）。瀏覽器 e2e 可用 Playwright 或沿用本專案慣用的 headless Chrome + CDP。
