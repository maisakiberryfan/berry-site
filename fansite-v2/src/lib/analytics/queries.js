// 查詢面板的靜態定義：進階模式範例與欄位參考。
//
// 「選取式建構器」（builder.js）取代了舊的簡易模式模板 —— 使用者用選的組出查詢，
// 產出的 SQL 一律以 bind params 執行；本檔只留兩件事：
//   exampleQueries()   進階 SQL 模式的一鍵範例
//   COLUMN_REFERENCE   欄位清單與三語說明（建構器與進階模式共用）
//
// 時區語意：berry_data.time 建表時已轉成瀏覽器時區的 'YYYY-MM-DD HH:MM' 字串，
// 所有條件直接寫本地日期即可，不做 UTC 轉換（見 dataset.js）。

export const TABLE_NAME = 'berry_data'

const pad = (n) => String(n).padStart(2, '0')

/** Date → 本地 'YYYY-MM-DD' */
function localDay(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDay(d)
}

/* ========================= 進階模式範例（SQLite 方言） ========================= */

export function exampleQueries() {
  const thisYearStart = `${new Date().getFullYear()}-01-01`
  return [
    {
      id: 'top20',
      label: { zh: 'Top 20', en: 'Top 20', ja: 'TOP 20' },
      sql: `SELECT songName, artist, COUNT(*) AS perfCount FROM ${TABLE_NAME} GROUP BY songID, songName, artist ORDER BY perfCount DESC LIMIT 20`,
    },
    {
      id: 'artists',
      label: { zh: '熱門歌手', en: 'Artists', ja: '歌手' },
      sql: `SELECT artist, COUNT(DISTINCT songID) AS songCount, COUNT(*) AS perfCount FROM ${TABLE_NAME} GROUP BY artist ORDER BY perfCount DESC LIMIT 20`,
    },
    {
      id: 'genre',
      label: { zh: '類型分類', en: 'Genre', ja: 'ジャンル' },
      sql: `SELECT genre, COUNT(*) AS perfCount FROM ${TABLE_NAME} WHERE genre IS NOT NULL AND genre != '' GROUP BY genre ORDER BY perfCount DESC`,
    },
    {
      id: 'thisYear',
      label: { zh: '今年 Top 10', en: 'This year top 10', ja: '今年 TOP 10' },
      sql: `SELECT songName, artist, COUNT(*) AS perfCount FROM ${TABLE_NAME} WHERE time >= '${thisYearStart}' GROUP BY songName, artist ORDER BY perfCount DESC LIMIT 10`,
    },
    {
      id: 'monthly',
      label: { zh: '月度統計', en: 'By month', ja: '月別集計' },
      sql: `SELECT month, COUNT(*) AS perfCount, COUNT(DISTINCT streamID) AS streamCount FROM ${TABLE_NAME} WHERE month IS NOT NULL GROUP BY month ORDER BY month DESC LIMIT 24`,
    },
    {
      id: 'duration',
      label: { zh: '平均曲長', en: 'Avg length', ja: '平均曲長' },
      sql: `SELECT songName, COUNT(*) AS perfCount, ROUND(AVG(durationSec), 1) AS avgSec FROM ${TABLE_NAME} WHERE durationSec IS NOT NULL GROUP BY songID, songName ORDER BY perfCount DESC LIMIT 20`,
    },
    {
      id: 'last30d',
      label: { zh: '最近 30 天', en: 'Last 30 days', ja: '直近 30 日' },
      sql: `SELECT songName, artist, time FROM ${TABLE_NAME} WHERE time >= '${daysAgo(30)}' ORDER BY time DESC`,
    },
  ]
}

/* ========================= 欄位參考 ========================= */

export const COLUMN_REFERENCE = [
  { name: 'streamID', type: 'TEXT', desc: { zh: '直播 ID', en: 'Stream ID', ja: '配信 ID' } },
  { name: 'streamTitle', type: 'TEXT', desc: { zh: '直播標題', en: 'Stream title', ja: '配信タイトル' } },
  {
    name: 'time',
    type: 'TEXT',
    short: { zh: '時間', en: 'Time', ja: '日時' },
    desc: {
      zh: '直播時間（你的當地時間，YYYY-MM-DD HH:MM）',
      en: 'Stream time (your local time, YYYY-MM-DD HH:MM)',
      ja: '配信時間（現地時間、YYYY-MM-DD HH:MM）',
    },
    example: "time >= '2025-11-03'",
  },
  { name: 'categories', type: 'TEXT', desc: { zh: '直播分類', en: 'Categories', ja: 'カテゴリ' } },
  { name: 'segmentNo', type: 'INTEGER', desc: { zh: '場次編號', en: 'Segment no.', ja: 'セグメント番号' } },
  { name: 'trackNo', type: 'INTEGER', desc: { zh: '曲目編號', en: 'Track no.', ja: 'トラック番号' } },
  { name: 'songID', type: 'INTEGER', desc: { zh: '歌曲 ID', en: 'Song ID', ja: '楽曲 ID' } },
  { name: 'songName', type: 'TEXT', desc: { zh: '歌名（日文）', en: 'Song name (JA)', ja: '曲名（日本語）' } },
  { name: 'songNameEn', type: 'TEXT', desc: { zh: '歌名（英文）', en: 'Song name (EN)', ja: '曲名（英語）' } },
  { name: 'artist', type: 'TEXT', desc: { zh: '歌手（日文）', en: 'Artist (JA)', ja: 'アーティスト（日本語）' } },
  { name: 'artistEn', type: 'TEXT', desc: { zh: '歌手（英文）', en: 'Artist (EN)', ja: 'アーティスト（英語）' } },
  { name: 'genre', type: 'TEXT', desc: { zh: '類型', en: 'Genre', ja: 'ジャンル' } },
  { name: 'tieup', type: 'TEXT', desc: { zh: '作品綁定', en: 'Tie-up', ja: 'タイアップ' } },
  { name: 'setlistNote', type: 'TEXT', desc: { zh: '歌單備註', en: 'Setlist note', ja: 'セットリスト備考' } },
  { name: 'songNote', type: 'TEXT', desc: { zh: '歌曲備註', en: 'Song note', ja: '楽曲備考' } },
  {
    name: 'startTime',
    type: 'INTEGER',
    desc: { zh: '曲目起點（秒）', en: 'Track start (sec)', ja: '開始位置（秒）' },
  },
  {
    name: 'endTime',
    type: 'INTEGER',
    desc: { zh: '曲目終點（秒）', en: 'Track end (sec)', ja: '終了位置（秒）' },
  },
  {
    name: 'month',
    type: 'TEXT',
    short: { zh: '月份', en: 'Month', ja: '月' },
    desc: {
      zh: '月份（YYYY-MM，由時間衍生）',
      en: 'Month (YYYY-MM, derived from time)',
      ja: '月（YYYY-MM、時間から導出）',
    },
    example: "month = '2026-01'",
  },
  {
    name: 'durationSec',
    type: 'INTEGER',
    short: { zh: '曲長（秒）', en: 'Length (sec)', ja: '曲長（秒）' },
    desc: {
      zh: '曲目長度（秒，終點－起點）',
      en: 'Track length (sec, end − start)',
      ja: '曲の長さ（秒、終了−開始）',
    },
  },
]
