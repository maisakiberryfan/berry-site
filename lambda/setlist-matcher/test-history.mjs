// 歷史歌單回歸：抽時間分散的場次，留言 → findSetlistComment → matcher → 與 DB setlist 比對
// 用法：node test-history.mjs [支數]
import { readFileSync } from 'node:fs'
process.env.BERRY_SITE_API_URL = 'https://m-b.win'
const { handler } = await import('./src/handler.js')

const N = Number(process.argv[2]) || 8
const devVars = readFileSync('../../.dev.vars', 'utf8')
const apiKey = devVars.match(/YOUTUBE_API_KEY\s*=\s*"?([^"\r\n]+)"?/)[1]

// --- 使用 berry-site 真實作（src/utils/data-processor.js），避免測試與 production 行為漂移 ---
const { DataProcessor } = await import('../../src/utils/data-processor.js')
const dp = new DataProcessor()
const findSetlistComment = (comments) => dp.findSetlistComment(comments)

async function getComments(videoId) {
  const url = `https://www.googleapis.com/youtube/v3/commentThreads?key=${apiKey}&textFormat=plainText&part=snippet&videoId=${videoId}&maxResults=100`
  const r = await fetch(url); const d = await r.json()
  if (!r.ok) throw new Error(d?.error?.message || 'YT API error')
  return (d.items || []).map(i => ({
    text: i.snippet.topLevelComment.snippet.textDisplay,
    authorDisplayName: i.snippet.topLevelComment.snippet.authorDisplayName,
    likeCount: i.snippet.topLevelComment.snippet.likeCount,
  }))
}

// --- 取全部 setlist，按 stream 分組（ground truth）---
const all = (await (await fetch('https://m-b.win/api/setlist')).json()).data
const byStream = new Map()
for (const row of all) {
  if (!byStream.has(row.streamID)) byStream.set(row.streamID, { time: row.time, rows: [] })
  byStream.get(row.streamID).rows.push(row)
}
const streams = [...byStream.entries()]
  .map(([id, v]) => ({ id, time: v.time, rows: v.rows.sort((a,b) => (a.segmentNo-b.segmentNo)||(a.trackNo-b.trackNo)) }))
  .sort((a, b) => new Date(a.time) - new Date(b.time))

// 抽樣：偏重早期（前 3 支）＋分位數，排除已測過的 Gh6AsG8DmCI
const pool = streams.filter(s => s.id !== 'Gh6AsG8DmCI')
const picks = new Set()
;[0, 1, 2].forEach(i => picks.add(pool[i].id))
for (let q = 1; picks.size < N && q < 20; q++) {
  picks.add(pool[Math.min(pool.length - 1, Math.floor(pool.length * q / (N - 2)))].id)
}
const targets = pool.filter(s => picks.has(s.id)).slice(0, N)

console.log(`抽樣 ${targets.length} 支（全庫 ${streams.length} 支）\n`)

let totalLines = 0, totalAgree = 0, streamsSkipped = 0
for (const s of targets) {
  const dbIDs = s.rows.map(r => String(r.songID))
  let comments
  try { comments = await getComments(s.id) } catch (e) {
    console.log(`■ ${s.id} (${s.time?.slice(0,10)}) — 留言抓取失敗: ${e.message}\n`); streamsSkipped++; continue
  }
  const picked = findSetlistComment(comments)
  if (!picked) { console.log(`■ ${s.id} (${s.time?.slice(0,10)}) — 找不到歌單留言（共 ${comments.length} 則）\n`); streamsSkipped++; continue }

  const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ setlistComment: picked.text }) })
  const body = JSON.parse(res.body)
  if (!body.success) { console.log(`■ ${s.id} — matcher 失敗: ${body.error?.message}\n`); streamsSkipped++; continue }

  const got = body.matches.map(m => String(m.finalSongID))
  // 序列對齊比較（同 index 比對；長度不同時各自記差異）
  const len = Math.max(got.length, dbIDs.length)
  let agree = 0
  const diffs = []
  for (let i = 0; i < len; i++) {
    if (got[i] === dbIDs[i]) { agree++; continue }
    diffs.push({ i, matcher: got[i] ?? '(無)', db: dbIDs[i] ?? '(無)', line: body.matches[i]?.parsed?.titleJP ?? '' })
  }
  totalLines += len; totalAgree += agree
  console.log(`■ ${s.id} (${s.time?.slice(0,10)}) 留言層${picked.layer} by ${picked.author} | matcher ${got.length} 行 vs DB ${dbIDs.length} 行 | 一致 ${agree}/${len}`)
  for (const d of diffs.slice(0, 8)) {
    console.log(`   [${d.i}] matcher=${d.matcher} db=${d.db} | ${d.line}`)
  }
  if (diffs.length > 8) console.log(`   ...另 ${diffs.length - 8} 處差異`)
  console.log()
}
console.log(`=== 總計：一致 ${totalAgree}/${totalLines} (${(totalAgree/totalLines*100).toFixed(1)}%)，跳過 ${streamsSkipped} 支 ===`)
