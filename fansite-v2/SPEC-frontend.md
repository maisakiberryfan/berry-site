# 前端現況規格（Explore 盤點 2026-08-08）

> 重做時保留品牌資產與行為相容的依據。現站原始碼盤點結果。

## 1. 草莓主題色票

共用：primary `#e24368`（rgb 226,67,104）

亮色（草莓牛奶，預設）：
- 背景 `#fcf4f6`、文字 `#3b2b31`、次要背景 `#f4e0e7`、第三背景 `#f8eaef`
- 邊框 `#e7cdd6`、連結 `#c92a5c`、連結 hover `#a1224a`
- 次要文字 `rgba(59,43,49,.75)`、第三文字 `rgba(59,43,49,.5)`、emphasis `#000`
- primary subtle bg `#f9d9e1`、subtle border `#f3b4c3`、text-emphasis `#5a1b2a`
- navbar 品牌字 `#b62450`（hover `#9c1d42`）

暗色（暗莓）：
- 背景 `#261a21`、文字 `#dee2e6`、次要背景 `#3c2a34`、第三背景 `#302129`
- 邊框 `#4f3b46`、連結 `#f193ab`、連結 hover `#f6b3c5`
- 次要文字 `rgba(222,226,230,.75)`、第三文字 `rgba(222,226,230,.5)`、emphasis `#fff`
- primary subtle bg `#2d0d15`、subtle border `#88283e`、text-emphasis `#ee8ea4`
- navbar 品牌字＝草莓粉

裝飾色（不隨主題）：草莓粉 `#f090a0`（rgb 240,144,160）、葉綠 accent `#45b384`、
::selection 螢光黃 `#f5d33f`＋深字 `#3b2b31`、YouTube icon `#ff0000`

取樣脈絡：logo 主字 `#E03058` 提亮 → primary；symbol 單色 `#F090A0`；葉綠 `#28B078`/`#90C878` → `#45B384`

## 2. 三語系統

- **key：`localStorage['lang']`**，值 `zh`/`en`/`ja`（新站沿用，偏好互通）
- 偵測：localStorage → navigator.language（zh*→zh、ja*→ja、其他→en）
- nav.json：label / labelEn / labelJa（ja/en 缺省 fallback label）
- 現站為行內三語 span（data-lang），新站改字典模組即可，但 key 與偵測順序沿用

## 3. 頁面內容

### 首頁（殼＋動態組裝）
- 主文：`fansite/pages/main.md`（三語 div data-lang，markdown）
- 最新影片卡：`GET /api/yt/latest`，縮圖 /tb/{id}.jpg → i.ytimg.com fallback；IDB SWR 秒開（key `ytlatest`）
- DB 更新時間：`GET /api/stats/last-updated`
- 最近更新：`fansite/changelog.json`（靜態，`{time, msg:{zh,en,ja}}`，markdown）
- **無直播中狀態功能**（只有最新影片卡）

### profile（fansite/pages/profile.htm ＋ profile.js）
- 頭像 `img/profile/profile.webp`、facts-grid（生日/出道/身高/年齡/血型/出身；出道時長由 data-debut 即時計算）
- hashtag 徽章連結、三語自介 blockquote、logo 區（mainlogo.webp / symbol.webp）
- BGM 播放器：`img/profile/bgm/{1..5}.mp3` radio 選台＋composer 顯示

### clothes（clothes.htm 骨架＋clothes.js 硬編資料）
- `sourceArray` 16 套：{name, date, designer, modeler, link(YT ID), count(立繪), tCount(差分), sideView(四面圖，選填)}
- 圖片：`img/clothes/{YYYYMMDD}/s{n}.webp`（列表縮圖 s1）、`t{n}.webp`、`c{n}.webp`
- 2D/3D 篩選、詳細 modal、Fancybox gallery、`#YYYYMMDD`/`#YYYYMMDD-N` hash 直達

### history：`fansite/pages/history.md` 純靜態 markdown（逐年 ## YYYY ＋條列）
### analytics：現站 DuckDB-WASM ＋外部 `https://sqldata.m-b.win/berry-data.parquet`
（新站已脫鉤：模板＝JS 聚合、自由 SQL＝sql.js 對快取資料查詢；parquet 管線退役）

## 4. 列表頁功能（新站需對等或簡化重現）

共通工具列：重新載入、編輯模式 toggle、新增、下載 CSV/JSON、進階搜尋（AND/OR＋7 種運算子——新站簡化為全文搜尋＋欄位篩選即可，7 運算子不必照搬）

- **songlist**：songID(隱)、曲名（songName+songNameEn 雙語）、歌手（artist+artistEn）、genre、tieup、songNote。雙語欄編輯需同時填日/英
- **streamlist**：縮圖、streamID(隱)、title（filter 同時比標題與 ID）、time、categories（**多值陣列**、tag 多選）、note。右鍵（歌枠類）：查看歌單/批次編輯/快速新增/複製網址/開 YT
- **setlist**：streamID(隱)、time（帶 YT 連結、filter 比日期與 ID）、segmentNo、trackNo、startTime/endTime（秒→h:mm:ss）、songName（選歌自動帶 songID/artist/artistEn/songNameEn；日文+英文兩行顯示）、artist（唯讀，隨選歌）、note、YTLink(隱)。新增流程：貼 YT 連結解析 streamID＋日期＋曲數 → 生成 N 空列（_isNew）→ 選歌時 POST、之後 PUT
- **aliases**：aliasID(隱)、aliasType（artist/title）、canonicalName（限從 songlist 選）、songID（title 可綁）、aliasValue、note。另有 grouped/quick-add/test/batch 子端點

## 5. 快取現況（新站重寫沿用思路）

- IDB：DB `berry-cache` / store `tables`（idb-keyval createStore）
- key：`table:{type}` → {data, etag, timestamp}；setlist：`setlist:meta` → {etag, timestamp, fingerprints, months} ＋ `setlist:m:{YYYY-MM}`（none bucket 殿後）
- manifest 流程：If-None-Match 打 manifest → 304 沿用 → 有變比 fingerprints → 只抓變更月份（?from&to 整月覆蓋重建，含刪除清理 idbDelMany）
- 顯示扁平化：月份 key 降序、月內依 API 順序（= time DESC）
- 快取秒開時 structuredClone 隔離

## 6. 縮圖

`/tb/{encodeURIComponent(id)}.jpg` → error 時 fallback `https://i.ytimg.com/vi/{id}/mqdefault.jpg`（once:true 防迴圈）；固定 160×90 佔位防跳動

## 7. 主題

- **key：`localStorage['theme']`**，值 `light`/`dark`（新站沿用）
- 優先序：`?theme=`（不落地）→ localStorage → prefers-color-scheme → light
- 現站屬性 `data-bs-theme`；新站用 `data-theme`（key 互通即可，屬性名無互通需求）

## 8. API 呼叫慣例（config.js）

- BASE_URL 空字串（同源相對路徑）
- 端點：songlist、songlist/artists、streamlist、setlist、aliases、aliases/grouped、aliases/quick-add、aliases/test、aliases/batch、health
- timeout 30s；重試 3 次遞增 delay，4xx 不重試
- 記憶體 ETag Map＋mutation 後關聯失效（改 songlist 連帶清 setlist）
