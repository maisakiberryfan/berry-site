// 音訊偵測批次清單產生器（唯讀）
// 三類目標：flagged（缺end撞下一首）/ nohistory（缺end無平均）/ outlier（已有時間但可疑）
// 輸出 e:/tmp/audio_batch/batch.json
const mysql = require('mysql2/promise')
const fs = require('fs')

const PLAN = 'e:/tmp/endtime_backfill_plan.json'
const OUTLIERS = 'e:/tmp/sec2_outliers.json'
const MB_CACHE = 'e:/tmp/mb_cache.json'
const OUT_DIR = 'e:/tmp/audio_batch'

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  const { flagged, noHistory } = JSON.parse(fs.readFileSync(PLAN, 'utf8'))
  const outliers = JSON.parse(fs.readFileSync(OUTLIERS, 'utf8'))
  const mb = JSON.parse(fs.readFileSync(MB_CACHE, 'utf8'))

  const conn = await mysql.createConnection({
    host: '163.44.98.136', port: 8081, user: 'root', password: '***REMOVED***', database: 'mbdb',
    ssl: { rejectUnauthorized: false },
  })
  // 全部 setlist 序列（nextStart 查詢）
  const [allRows] = await conn.query(`
    SELECT streamID, segmentNo, trackNo, CAST(startTime AS SIGNED) st
    FROM setlist_ori WHERE startTime IS NOT NULL`)
  const bySeg = new Map()
  for (const r of allRows) {
    const k = `${r.streamID}|${r.segmentNo}`
    if (!bySeg.has(k)) bySeg.set(k, [])
    bySeg.get(k).push(r)
  }
  for (const [, a] of bySeg) a.sort((x, y) => x.trackNo - y.trackNo)
  const nextStart = (sid, seg, tr) => {
    for (const r of (bySeg.get(`${sid}|${seg}`) || []))
      if (r.trackNo > tr && r.st != null) return Number(r.st)
    return null
  }
  // 各歌已知樣本中位（nohistory 估計用）
  const [durRows] = await conn.query(`
    SELECT songID, CAST(endTime AS SIGNED)-CAST(startTime AS SIGNED) d
    FROM setlist_ori WHERE startTime IS NOT NULL AND endTime IS NOT NULL
      AND CAST(endTime AS SIGNED)-CAST(startTime AS SIGNED) BETWEEN 60 AND 900`)
  const dursBySong = new Map()
  for (const r of durRows) {
    if (!dursBySong.has(r.songID)) dursBySong.set(r.songID, [])
    dursBySong.get(r.songID).push(Number(r.d))
  }
  const [slRows] = await conn.query(`SELECT songID, duration FROM songlist`)
  const slDur = new Map(slRows.map(r => [r.songID, r.duration ? Number(r.duration) : null]))
  await conn.end()

  const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
  const batch = []

  // --- flagged: 窗口 [start+45, nextStart]（真實 end 必在其間）---
  for (const f of flagged) {
    const ns = f.nextStart ?? nextStart(f.streamID, f.segmentNo, f.trackNo)
    let ws = f.startTime + 45
    let we = ns ?? f.endTime + 120
    if (we - ws < 90) ws = Math.max(f.startTime + 20, we - 150)
    batch.push({
      id: `${f.streamID}_${f.segmentNo}_${f.trackNo}`, kind: 'flagged',
      streamID: f.streamID, segmentNo: f.segmentNo, trackNo: f.trackNo,
      songID: f.songID, songName: f.songName,
      startTime: f.startTime, recEnd: null, est: f.duration,
      windowStart: ws, windowEnd: we, nextStart: ns,
    })
  }

  // --- nohistory: est = songlist.duration > MB > 散樣本中位 > 270 ---
  for (const n of noHistory) {
    const est = slDur.get(n.songID) || (mb[n.songID] && mb[n.songID].dur) ||
      (dursBySong.has(n.songID) ? median(dursBySong.get(n.songID)) : null) || 270
    const ns = nextStart(n.streamID, n.segmentNo, n.trackNo)
    const ws = n.startTime + 40
    let we = n.startTime + Math.min(est + 150, 600)
    if (ns != null && ns < we) we = ns
    if (we - ws < 60) continue // 窗口太短無法偵測（gap 小），留人工
    batch.push({
      id: `${n.streamID}_${n.segmentNo}_${n.trackNo}`, kind: 'nohistory',
      streamID: n.streamID, segmentNo: n.segmentNo, trackNo: n.trackNo,
      songID: n.songID, songName: n.songName,
      startTime: n.startTime, recEnd: null, est,
      windowStart: ws, windowEnd: we, nextStart: ns,
    })
  }

  // --- outlier (|diff|>10s): 窗口 [start-75, end+75] 雙端偵測 ---
  const conn2 = await mysql.createConnection({
    host: '163.44.98.136', port: 8081, user: 'root', password: '***REMOVED***', database: 'mbdb',
    ssl: { rejectUnauthorized: false },
  })
  let outCnt = 0
  for (const song of outliers) {
    for (const o of song.outliers) {
      if (Math.abs(o.diff) <= 10) continue
      const [rows] = await conn2.query(
        `SELECT CAST(startTime AS SIGNED) st, CAST(endTime AS SIGNED) et
         FROM setlist_ori WHERE streamID=? AND segmentNo=? AND trackNo=?`,
        [o.streamID, o.segmentNo, o.trackNo])
      if (!rows.length || rows[0].st == null || rows[0].et == null) continue
      const st = Number(rows[0].st), et = Number(rows[0].et)
      outCnt++
      batch.push({
        id: `${o.streamID}_${o.segmentNo}_${o.trackNo}`, kind: 'outlier',
        streamID: o.streamID, segmentNo: o.segmentNo, trackNo: o.trackNo,
        songID: song.songID, songName: song.songName,
        startTime: st, recEnd: et, est: song.groups[0] ? song.groups[0].avg : null,
        diff: o.diff,
        windowStart: Math.max(0, st - 75), windowEnd: et + 75, nextStart: null,
      })
    }
  }
  await conn2.end()

  const stat = batch.reduce((m, b) => (m[b.kind] = (m[b.kind] || 0) + 1, m), {})
  const totalSec = batch.reduce((a, b) => a + (b.windowEnd - b.windowStart), 0)
  console.log(`批次: ${batch.length} 筆  ${JSON.stringify(stat)}`)
  console.log(`音訊總長: ${(totalSec / 3600).toFixed(1)}hr  估計下載: ${(batch.length * 115 / 3600).toFixed(1)}hr`)
  fs.writeFileSync(`${OUT_DIR}/batch.json`, JSON.stringify(batch, null, 1))
  console.log(`Saved ${OUT_DIR}/batch.json`)
}
main().catch(e => { console.error(e); process.exit(1) })
