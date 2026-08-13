# 後端 API 契約規格（Explore 盤點 2026-08-08, commit 3d380cc）

> 新前端沿用既有後端。本文件為資料層實作唯一依據，欄位名大小寫皆準確。

## 0. 回應信封 — 三套並存！

| 路由群組 | 成功 | 錯誤 |
|---|---|---|
| songlist / streamlist / setlist | `{"data": <T>}` | `{"error": {"code", "message", "fieldErrors"?}}` |
| aliases | `{"success": true, "data": <T>, "count"?, "isNew"?}` | `{"success": false, "error": {"message", "details"?}}` |
| stats/last-updated、yt/latest | `{"success": true, "data": <T>}` | `{"success": false, "error": "<字串>"}` |
| yt（無id）/ yt/newvideos / yt/live-details | ad-hoc 形狀 | `{"error": "<字串>"}` |

error.code 值：VALIDATION_ERROR、NOT_FOUND、CONFLICT、CONSTRAINT_VIOLATION(409 刪除被引用)、DUPLICATE_ENTRY(409)、DATABASE_ERROR(500)、INTERNAL_ERROR(500)

## 1. setlist

- `GET /api/setlist` 三模式：
  - **單場** `?streamID=xxx`：ORDER BY segmentNo, trackNo。無 ETag
  - **月度** `?from=YYYY-MM&to=YYYY-MM`（皆可省略；`from=none`/`to=none`＝不留檔場 bucket，time IS NULL）。**無 ETag、不會 304**。格式錯回 400
  - **全量**（無 query）：meta ETag，If-None-Match 相符回 304 空 body。ORDER BY time DESC, segmentNo, trackNo
- 列形狀（VIEW，三模式共用）：
  ```json
  {"streamID":"WQmkV-E-730","YTLink":"https://www.youtube.com/watch?v=WQmkV-E-730&t=419",
   "time":"2026-07-24T12:00:00.000Z","segmentNo":1,"trackNo":1,"songID":772,
   "songName":"...","songNameEn":"...","artist":"...","artistEn":"...","note":null,
   "startTime":419,"endTime":611}
  ```
  - time：ISO8601 UTC 或 null（none bucket）；startTime/endTime：**秒數** 或 null
  - YTLink：startTime null 時可能不完整，**渲染前檢查 `startsWith('https://')`**
  - **VIEW 不含** genre/tieup/songNote/streamTitle/categories/setlistComplete——setlist 頁要顯示場次標題需客端 join streamlist
- `GET /api/setlist/manifest`：**有 ETag**（與全量共用 meta，304=整份沒變）
  ```json
  {"data":{"version":"v1","months":[{"month":"2026-07","count":42,"maxUpdated":"2026-07-24 12:03:11.000000"}]}}
  ```
  - maxUpdated 是 **MySQL 原始字串**，當不透明指紋用勿 parse；month 有 `"none"` 值恆排最後；version 要摻進快取指紋
- `POST /api/setlist`：單筆或陣列（≤200）。必填 streamID、trackNo；選填 segmentNo(預設1)、songID、note(≤1000)
  - streamID 必須存在於 streamlist（否則 404）、songID 若給必須存在（否則 404）
  - **必帶 `X-Source: user`** header——否則被當 worker 自動更新，只在原值 NULL/空時才生效！
  - 201 回應是 setlist_ori 原始 row（**不含 join 欄位**）——前端寫入後自行本地補 join
- `PUT /api/setlist/:streamID/:segmentNo/:trackNo`：body 選填 `{songID?, note?, startTime?, endTime?}`；
  startTime/endTime 為 null 或 0~360000 整數秒（**fansite-v2 分支新增**，向後相容——舊前端不送即不動）；
  無欄位變動回 200 現有 row；404 找不到
- `DELETE /api/setlist/:streamID/:segmentNo/:trackNo`：成功 `{"data":{"message":"..."}}`

## 2. songlist

- `GET /api/songlist`（全量，**ETag**）：ORDER BY songID DESC
  ```json
  {"songID":772,"songName":"...","songNameEn":null,"artist":null,"artistEn":null,
   "genre":null,"tieup":null,"songNote":null,"updatedAt":"2026-07-24 12:03:11.000000"}
  ```
  updatedAt 為 **MySQL 原始字串未轉 ISO**
- `GET /api/songlist/:songID`：單曲（不含 updatedAt），404
- `POST /api/songlist`：必填 songName；選填 songNameEn/artist/artistEn/genre/tieup/songNote（皆 ≤500）。201 回完整 row
- `PUT /api/songlist/:songID`：只更新 body 有出現的欄位；404
- `DELETE /api/songlist/:songID`：被 setlist 引用回 **409 CONSTRAINT_VIOLATION**
- `GET /api/songlist/artists?q=`：`{"data":[{"artist","artistEn"}]}` DISTINCT，LIKE %q% 只搜 artist
- `GET /api/songlist.json`：`{"data":{"772":"songName|artist|songNameEn|artistEn"}}` **段數可變 2~4**（En 缺省不 push）
- `GET /api/songlist/optimized`：同形狀但**固定 4 段**＋Content-Disposition 下載 header。兩支 parser 不可共用

## 3. streamlist

- `GET /api/streamlist`（全量，**ETag**）：ORDER BY time DESC
  ```json
  {"streamID":"WQmkV-E-730","title":"...","time":"2026-07-24T12:00:00.000Z",
   "categories":["歌枠"],"note":null,"setlistComplete":true}
  ```
  categories 一律陣列（自由字串 tag）；time ISO8601 UTC
- `GET /api/streamlist/:streamID`：單場，404
- `POST /api/streamlist`：必填 streamID/title/time/categories；選填 note
  - streamID regex `^[A-Za-z0-9_-]{9,11}$`；categories ≤20 項各 ≤100 字；title/note ≤500
  - setlistComplete 自動判定：categories 含「歌枠」→false，否則 true
  - 409 若已存在
- `PUT /api/streamlist/:streamID`：全選填；categories 變更且未帶 setlistComplete 時自動調整
- `DELETE`：被引用 409
- `PATCH /api/streamlist/bulk-categories`：`{streamIDs:[1-100], categories:[]}` 整批**覆寫**。（CORS allowMethods 無 PATCH，但同源部署/proxy dev 不觸發 CORS，可用）
- `GET /api/streamlist/latest`：`{"data":{"time": "...|null"}}`
- `GET /api/streamlist/pending?recent=true`：未解析歌枠

## 4. aliases（信封是 success+data！無任何快取）

row：`{"aliasID":80,"aliasType":"title|artist","canonicalName":"...","aliasValue":"...","note":null,"songID":855,"createdAt","updatedAt"}`
- songID 僅 title 別名有意義（精準綁曲）；artist 別名恆為字串表
- `GET /api/aliases`：`{"success":true,"data":[...],"count":87}` ORDER BY aliasType, canonicalName, aliasValue
- `GET /api/aliases/grouped`：`{"success":true,"data":{"artistAliases":{canonical:[values]},"titleAliases":{...},"titleAliasesByID":{"855":[values]}}}`
- `POST /api/aliases/quick-add`：`{aliasType, canonicalName, aliasValue, note?, songID?}`（各 ≤500）。Upsert on (type,canonical,value)。回 `{success, data, isNew}` 201/200
- `POST /api/aliases/test`：`{aliasType, inputText}` → `{data:{inputText, aliasType, matches:[{canonicalName, aliases:[{value,note}]}], matchCount}}`
- `POST /api/aliases/batch`：`{aliases:[{aliasType,canonicalName,aliasValue,note?}]}` 1-100 筆，**不支援 songID**。回 `{data:{total,inserted,updated,errors?}}`
- `PUT /api/aliases/:aliasID`：選填 canonicalName/aliasValue/note/songID（null 或 "" =解綁）
- `DELETE /api/aliases/:aliasID`：`{success, data:{deletedAlias, message}}`

## 5. 其他

- `GET /api/stats/last-updated`：`{"success":true,"data":{"streamlist":"...","setlist":"...","songlist":"..."}}` MySQL 原始字串，可 null
- `GET /api/yt/latest`：`{success, data:{videoId, title, time(ISO), categories}}`（已排除 30 天後排程佔位）

## 6. ETag 機制

- ETag 值形如 `"mv1-1a2b3c4d"`（**引號是值的一部分**）
- 支援 304：setlist 全量、setlist/manifest、songlist 全量、streamlist 全量。**其餘端點皆不支援**
- 304 回應空 body＋ETag header；200 帶新 ETag
- CORS 已白名單 If-None-Match（送出）與 exposeHeaders ETag（讀取）
- ETAG_VERSION bump（格式變更時）→ 舊 ETag 自然失效，前端拿到 200 整包替換即可
- 月度端點永遠 200——月度快取靠 manifest 應用層比對（version＋count＋maxUpdated 當指紋）

## 7. CORS 與本地開發

- 白名單 origin：m-b.win、www.m-b.win、localhost:8787/8788、127.0.0.1:3001/8787/8788、*.maisakiberry.pages.dev
- **Vite 5173 不在白名單 → dev 一律走 vite proxy（已設定），瀏覽器同源無 CORS 問題**；正式部署同源亦無
- allowedHeaders：Content-Type, Authorization, X-Requested-With, **X-Source**, If-None-Match

## 8. Rate limit 與寫入注意

- 寫入（非 GET）30 次/分鐘/IP；parse-setlist、text-to-sql 5 次/分鐘。429 `{"error":"Too many requests"}`
- **編輯 UI 不可做逐鍵自動儲存**——drawer 表單「儲存」一次送出正合適
- 所有 POST/PUT/PATCH 必帶 `Content-Type: application/json`（缺了會 500 INTERNAL_ERROR）
- 一般 CRUD 不需 X-Trigger-Token
