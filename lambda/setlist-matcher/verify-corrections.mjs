// 對歷史「誤判→人工修正」事故場次重跑修復版 matcher，驗證是否不再誤判
// 場次來源：sqlBackUp 130 份快照挖掘（mine-corrections.mjs）
import { readFileSync } from 'node:fs'
process.env.BERRY_SITE_API_URL = 'https://m-b.win'
const { handler } = await import('./src/handler.js')

const TARGETS = [
  ['IVQA0vzQSkE', '2/17 整場 18 首誤判成初回'],
  ['G2bAzs2LvaM', '全形括號歌手（宇野ゆう子（Yuko uno)）'],
  ['4N7DZCNFQmE', '旅立ちの日に 誤判初回'],
  ['4Woolc-Rm6k', 'アイモ→アイマイモコ 相似名'],
  ['cjoHiHOFM8E', 'MOON PRIDE→Moon Revenge 相似名'],
  ['JN7eyNcMSEE', 'そばかす→そうだよ。'],
  ['gqR4KMHCcME', 'promise→Precious 相似名'],
  ['8h5LnkApAL0', '最上級にかわいいの！→わたしの一番かわいいところ'],
  ['js0DFgmhojw', '位移鏈（疑似漏行）'],
  ['jSf7vIaP3jE', '位移鏈'],
  ['hWWwIoQLBWg', '位移鏈'],
  ['6JcIj-P7qtU', '順序對調（雙 segment）'],
]

const devVars = readFileSync('../../.dev.vars', 'utf8')
const apiKey = devVars.match(/YOUTUBE_API_KEY\s*=\s*"?([^"\r\n]+)"?/)[1]

// 使用 berry-site 真實作（src/utils/data-processor.js），避免測試與 production 行為漂移
const { DataProcessor } = await import('../../src/utils/data-processor.js')
const dp = new DataProcessor()
const findSetlistComment = (comments) => dp.findSetlistComment(comments)

async function getComments(videoId) {
  const url = `https://www.googleapis.com/youtube/v3/commentThreads?key=${apiKey}&textFormat=plainText&part=snippet&videoId=${videoId}&maxResults=100`
  const r = await fetch(url); const d = await r.json()
  if (!r.ok) throw new Error(d?.error?.message?.replace(/<[^>]+>/g, '') || 'YT API error')
  return (d.items || []).map(i => ({
    text: i.snippet.topLevelComment.snippet.textDisplay,
    authorDisplayName: i.snippet.topLevelComment.snippet.authorDisplayName,
    likeCount: i.snippet.topLevelComment.snippet.likeCount,
  }))
}

const all = (await (await fetch('https://m-b.win/api/setlist')).json()).data
let totalLines = 0, totalAgree = 0, totalNew = 0
for (const [sid, desc] of TARGETS) {
  const rows = all.filter(r => r.streamID === sid).sort((a, b) => (a.segmentNo - b.segmentNo) || (a.trackNo - b.trackNo))
  const dbIDs = rows.map(r => String(r.songID))
  if (dbIDs.length === 0) { console.log(`■ ${sid} — DB 無 setlist，跳過\n`); continue }

  let comments
  try { comments = await getComments(sid) } catch (e) { console.log(`■ ${sid} — 留言抓取失敗: ${e.message}\n`); continue }
  const picked = findSetlistComment(comments)
  if (!picked) { console.log(`■ ${sid} — 找不到歌單留言\n`); continue }

  const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ setlistComment: picked.text }) })
  const body = JSON.parse(res.body)
  if (!body.success) { console.log(`■ ${sid} — matcher 失敗\n`); continue }

  const got = body.matches.map(m => String(m.finalSongID))
  const len = Math.max(got.length, dbIDs.length)
  let agree = 0, news = 0
  const diffs = []
  for (let i = 0; i < len; i++) {
    if (got[i] === '*') news++
    if (got[i] === dbIDs[i]) { agree++; continue }
    diffs.push(`   [${i}] matcher=${got[i] ?? '(無)'} db=${dbIDs[i] ?? '(無)'} | ${body.matches[i]?.parsed?.titleJP ?? ''}`)
  }
  totalLines += len; totalAgree += agree; totalNew += news
  console.log(`■ ${sid}（${desc}）層${picked.layer} | matcher ${got.length} vs DB ${dbIDs.length} | 一致 ${agree}/${len} | 建新歌 ${news}`)
  diffs.slice(0, 6).forEach(d => console.log(d))
  if (diffs.length > 6) console.log(`   ...另 ${diffs.length - 6} 處`)
  console.log()
}
console.log(`=== 總計 一致 ${totalAgree}/${totalLines} (${(totalAgree / totalLines * 100).toFixed(1)}%)，建新歌 ${totalNew} 行 ===`)
