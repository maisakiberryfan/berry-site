// 查詢資料集：把瀏覽器裡「已經有」的快取（setlist VIEW ＋ streamlist ＋ songlist）
// 攤平成一張寬表，給簡易模式的 JS 聚合與進階模式的 sql.js 建表共用。
//
// ── 為什麼不再抓 parquet ────────────────────────────────────────────────
// 舊版走 DuckDB-WASM + https://sqldata.m-b.win/berry-data.parquet：引擎約 20MB、
// parquet 是每日快照。但同一份資料本來就躺在 IndexedDB（store.svelte.js 的三張表），
// 而且是背景校正過的最新值——外部管線既慢又比較舊，整條退役。
//
// ── 欄位 ────────────────────────────────────────────────────────────────
// 前 15 欄與舊 parquet 逐字對齊（既有 SQL 不用改），另補 startTime / endTime
// （parquet 沒有，快取裡是現成的）與兩個衍生欄：
//   month       = time 前 7 碼 'YYYY-MM'（不留檔場為 NULL）
//                 → 建構器「分組」直接選月份，不必手寫 substr(time, 1, 7)
//   durationSec = endTime - startTime（兩者皆有且 end > start 時）
//                 → 配聚合就能算平均／總曲長；缺任一端或矛盾時 NULL（不猜）
//
// ── 時間語意（沿用現站）──────────────────────────────────────────────────
// DB 的 time 是 UTC；這裡在建表時就轉成「瀏覽器所在時區的牆鐘字串」
// 'YYYY-MM-DD HH:MM'，使用者寫 SQL 時直接寫本地日期即可（WHERE time >= '2026-01-01'）。
// SQLite 沒有原生 timestamp 型別，字串比較對這個固定寬度格式即是時序比較。
// 沒有時間的列（不留檔場）time 為 NULL，任何比較都會把它排除，與舊版一致。

/** 資料表欄位定義（順序即 CREATE TABLE 的欄序） */
export const DATASET_COLUMNS = [
  { key: 'streamID', sqlType: 'TEXT' },
  { key: 'streamTitle', sqlType: 'TEXT' },
  { key: 'time', sqlType: 'TEXT' },
  { key: 'categories', sqlType: 'TEXT' },
  { key: 'segmentNo', sqlType: 'INTEGER' },
  { key: 'trackNo', sqlType: 'INTEGER' },
  { key: 'songID', sqlType: 'INTEGER' },
  { key: 'songName', sqlType: 'TEXT' },
  { key: 'songNameEn', sqlType: 'TEXT' },
  { key: 'artist', sqlType: 'TEXT' },
  { key: 'artistEn', sqlType: 'TEXT' },
  { key: 'genre', sqlType: 'TEXT' },
  { key: 'tieup', sqlType: 'TEXT' },
  { key: 'setlistNote', sqlType: 'TEXT' },
  { key: 'songNote', sqlType: 'TEXT' },
  { key: 'startTime', sqlType: 'INTEGER' },
  { key: 'endTime', sqlType: 'INTEGER' },
  { key: 'month', sqlType: 'TEXT' },
  { key: 'durationSec', sqlType: 'INTEGER' },
]

const pad = (n) => String(n).padStart(2, '0')

/** ISO UTC 字串 → 瀏覽器時區的 'YYYY-MM-DD HH:MM'；無法解析回 null */
export function toLocalWallClock(iso) {
  if (typeof iso !== 'string' || !iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** 多值分類欄位 → 單一字串（parquet 版也是字串） */
function categoriesText(v) {
  if (Array.isArray(v)) {
    const s = v.filter((x) => typeof x === 'string' && x).join(', ')
    return s || null
  }
  return typeof v === 'string' && v ? v : null
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function text(v) {
  return typeof v === 'string' ? v : v == null ? null : String(v)
}

// 輸入 identity 沒變就回同一個陣列——引擎靠 identity 判斷要不要重建表
let memoSetlist = null
let memoSongs = null
let memoResult = null

/**
 * @param {Array} setlistRows  store 的 setlistJoined.rows（含 streamTitle / streamCategories）
 * @param {Map}   songMap      store 的 songIndex.map（補 genre / tieup / songNote）
 * @returns {Array<object>}    寬表列（欄位同 DATASET_COLUMNS）
 */
export function buildDataset(setlistRows, songMap) {
  if (memoResult && memoSetlist === setlistRows && memoSongs === songMap) return memoResult

  const rows = new Array(setlistRows.length)
  for (let i = 0; i < setlistRows.length; i++) {
    const r = setlistRows[i]
    const song = r.songID != null ? songMap?.get(r.songID) : null
    const localTime = toLocalWallClock(r.time)
    const start = num(r.startTime)
    const end = num(r.endTime)
    rows[i] = {
      streamID: text(r.streamID),
      streamTitle: text(r.streamTitle),
      time: localTime,
      categories: categoriesText(r.streamCategories),
      segmentNo: num(r.segmentNo),
      trackNo: num(r.trackNo),
      songID: num(r.songID),
      // songlist 是曲名正本；曲被刪掉時退回 VIEW 帶的值
      songName: text(song?.songName ?? r.songName),
      songNameEn: text(song?.songNameEn ?? r.songNameEn),
      artist: text(song?.artist ?? r.artist),
      artistEn: text(song?.artistEn ?? r.artistEn),
      genre: text(song?.genre ?? null),
      tieup: text(song?.tieup ?? null),
      setlistNote: text(r.note),
      songNote: text(song?.songNote ?? null),
      startTime: start,
      endTime: end,
      month: localTime ? localTime.slice(0, 7) : null,
      durationSec: start != null && end != null && end > start ? end - start : null,
    }
  }

  memoSetlist = setlistRows
  memoSongs = songMap
  memoResult = rows
  return rows
}
