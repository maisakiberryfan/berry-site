// endTime 全量補填計畫產生器（唯讀，不寫 DB）
// 涵蓋 sec1（多版本歌日期配組）+ sec2/other（單組平均）+ 單筆歷史沿用
// 輸出: e:/tmp/endtime_backfill_plan.json + endtime_backfill_report.txt
import mysql from 'mysql2/promise'
import { dbConfig } from './db-config.cjs'
import fs from 'fs'

const GROUP_TOLERANCE = 5
const MIN_GROUP_SIZE = 2
const OUTPUT_DIR = 'e:/tmp'

const conn = await mysql.createConnection(dbConfig('mbdb'))

const fmt = s => s == null ? '?' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// === 已知曲長樣本 → 聚類 ===
const [records] = await conn.query(`
  SELECT s.songID, sl.songName, sl.artist,
         s.streamID, s.segmentNo, s.trackNo,
         CAST(s.endTime AS SIGNED) - CAST(s.startTime AS SIGNED) as actual,
         st.time
  FROM setlist_ori s
  JOIN songlist sl ON s.songID = sl.songID
  LEFT JOIN streamlist st ON s.streamID = st.streamID
  WHERE s.startTime IS NOT NULL AND s.endTime IS NOT NULL
    AND CAST(s.endTime AS SIGNED) - CAST(s.startTime AS SIGNED) > 0
  ORDER BY s.songID, st.time`)

const songs = new Map()
for (const r of records) {
  if (!songs.has(r.songID)) songs.set(r.songID, { songName: r.songName, artist: r.artist, entries: [] })
  songs.get(r.songID).entries.push({
    actual: Number(r.actual),
    date: r.time ? new Date(r.time).toISOString().slice(0, 10) : '?'
  })
}

function clusterEntries(entries) {
  const sorted = [...entries].sort((a, b) => a.actual - b.actual)
  const groups = []
  const used = new Set()
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue
    const group = [sorted[i]]
    used.add(i)
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue
      const avg = group.reduce((a, e) => a + e.actual, 0) / group.length
      if (Math.abs(sorted[j].actual - avg) <= GROUP_TOLERANCE) { group.push(sorted[j]); used.add(j) }
    }
    groups.push(group)
  }
  const valid = groups.filter(g => g.length >= MIN_GROUP_SIZE)
  for (const g of valid) g.sort((a, b) => a.date.localeCompare(b.date))
  valid.sort((a, b) => a[0].date.localeCompare(b[0].date))
  return valid.map(g => ({
    avg: Math.round(g.reduce((a, e) => a + e.actual, 0) / g.length),
    count: g.length, dateStart: g[0].date, dateEnd: g[g.length - 1].date
  }))
}

const clusters = new Map() // songID → { groups, singleVal, total }
for (const [songID, song] of songs) {
  const groups = clusterEntries(song.entries)
  clusters.set(songID, {
    songName: song.songName, artist: song.artist, groups,
    singleVal: song.entries.length === 1 ? song.entries[0].actual : null,
    total: song.entries.length
  })
}

// === 缺 endTime 記錄 ===
const [missing] = await conn.query(`
  SELECT s.streamID, s.segmentNo, s.trackNo, s.songID,
         CAST(s.startTime AS SIGNED) startTime,
         sl.songName, sl.artist, st.time
  FROM setlist_ori s
  JOIN songlist sl ON s.songID = sl.songID
  LEFT JOIN streamlist st ON s.streamID = st.streamID
  WHERE s.endTime IS NULL AND s.startTime IS NOT NULL
  ORDER BY st.time, s.streamID, s.segmentNo, s.trackNo`)
console.log(`缺 endTime: ${missing.length} 筆`)

// 每場每 segment 的曲序（下一首 startTime 守衛用）
const [allRows] = await conn.query(`
  SELECT streamID, segmentNo, trackNo, CAST(startTime AS SIGNED) startTime
  FROM setlist_ori WHERE startTime IS NOT NULL`)
const bySeg = new Map()
for (const r of allRows) {
  const k = `${r.streamID}|${r.segmentNo}`
  if (!bySeg.has(k)) bySeg.set(k, [])
  bySeg.get(k).push(r)
}
for (const [, arr] of bySeg) arr.sort((a, b) => a.trackNo - b.trackNo)
function nextStart(streamID, segmentNo, trackNo) {
  const arr = bySeg.get(`${streamID}|${segmentNo}`) || []
  for (const r of arr) if (r.trackNo > trackNo && r.startTime != null) return { trackNo: r.trackNo, startTime: Number(r.startTime) }
  return null
}

// === 分類補填 ===
const plan = []       // 可寫入
const flagged = []    // 推算超過下一首 start（需人工看）
const manual = []     // 無法自動判定（between groups / 無日期）
const noHistory = []  // 無歷史樣本

for (const r of missing) {
  const c = clusters.get(r.songID)
  const streamDate = r.time ? new Date(r.time).toISOString().slice(0, 10) : null
  const base = {
    streamID: r.streamID, segmentNo: r.segmentNo, trackNo: r.trackNo,
    songID: r.songID, songName: r.songName, artist: r.artist,
    startTime: Number(r.startTime), streamDate
  }
  if (!c || (c.groups.length === 0 && c.singleVal == null)) {
    noHistory.push(base)
    continue
  }

  let dur = null, source = null
  if (c.groups.length >= 2) {
    // sec1: 日期配組
    let matched = null
    if (streamDate) {
      for (const g of c.groups) if (streamDate >= g.dateStart && streamDate <= g.dateEnd) { matched = g; break }
    }
    const first = c.groups[0], last = c.groups[c.groups.length - 1]
    if (matched) { dur = matched.avg; source = `group(${matched.avg}s×${matched.count} ${matched.dateStart}~${matched.dateEnd})` }
    else if (!streamDate) { manual.push({ ...base, reason: 'no_stream_date', groups: c.groups }); continue }
    else if (streamDate < first.dateStart) { dur = first.avg; source = `earliest_group(${first.avg}s×${first.count})` }
    else if (streamDate > last.dateEnd) { dur = last.avg; source = `latest_group(${last.avg}s×${last.count})` }
    else { manual.push({ ...base, reason: 'between_groups', groups: c.groups }); continue }
  } else if (c.groups.length === 1) {
    // sec2/other: 單組
    dur = c.groups[0].avg
    source = `single_group(${c.groups[0].avg}s×${c.groups[0].count})`
  } else {
    // 單筆歷史
    dur = c.singleVal
    source = `single_history(${c.singleVal}s×1)`
  }

  const endTime = base.startTime + dur
  const nxt = nextStart(r.streamID, r.segmentNo, r.trackNo)
  if (nxt && endTime > nxt.startTime) {
    flagged.push({ ...base, duration: dur, endTime, source,
      nextTrack: nxt.trackNo, nextStart: nxt.startTime, overlap: endTime - nxt.startTime })
  } else {
    plan.push({ ...base, duration: dur, endTime, source,
      nextStart: nxt ? nxt.startTime : null })
  }
}

// === 統計與輸出 ===
const srcStat = {}
for (const p of plan) {
  const k = p.source.split('(')[0]
  srcStat[k] = (srcStat[k] || 0) + 1
}
console.log(`可寫入: ${plan.length}`)
console.log(`來源分佈: ${JSON.stringify(srcStat)}`)
console.log(`超過下一首start(flagged): ${flagged.length}`)
console.log(`需人工(manual): ${manual.length}`)
console.log(`無歷史(noHistory): ${noHistory.length}`)
console.log(`合計: ${plan.length + flagged.length + manual.length + noHistory.length} / ${missing.length}`)

fs.writeFileSync(`${OUTPUT_DIR}/endtime_backfill_plan.json`, JSON.stringify({
  generated: new Date().toISOString(),
  summary: { writable: plan.length, flagged: flagged.length, manual: manual.length, noHistory: noHistory.length, srcStat },
  plan, flagged, manual, noHistory
}, null, 1))

const out = []
out.push(`endTime 全量補填計畫 — ${new Date().toISOString().slice(0, 10)}`)
out.push('='.repeat(80))
out.push(`缺 endTime 總數: ${missing.length}`)
out.push(`可寫入: ${plan.length}   來源: ${Object.entries(srcStat).map(([k, v]) => `${k}=${v}`).join(', ')}`)
out.push(`flagged(推算值超過下一首開始，需人工): ${flagged.length}`)
out.push(`manual(組間空窗/無日期): ${manual.length}`)
out.push(`noHistory(無歷史樣本，另案處理): ${noHistory.length}`)
out.push('')
out.push('='.repeat(80))
out.push(`【flagged 明細】推算 endTime 晚於下一首 startTime — 通常表示該場唱了短版或 startTime 有誤`)
out.push('='.repeat(80))
for (const f of flagged) {
  out.push(`\n${f.songName} / ${f.artist} (songID=${f.songID})  ${f.streamID} seg${f.segmentNo}#${f.trackNo}  ${f.streamDate}`)
  out.push(`  start=${fmt(f.startTime)} + ${f.duration}s → end=${fmt(f.endTime)}  但下一首#${f.nextTrack} start=${fmt(f.nextStart)}（超出 ${f.overlap}s）`)
  out.push(`  https://www.youtube.com/watch?v=${f.streamID}&t=${f.startTime}s`)
}
out.push('')
out.push('='.repeat(80))
out.push(`【抽樣明細】plan 前 30 筆`)
out.push('='.repeat(80))
for (const p of plan.slice(0, 30)) {
  out.push(`  ${p.streamID} seg${p.segmentNo}#${p.trackNo} ${p.streamDate}  ${p.songName}  ${fmt(p.startTime)}→${fmt(p.endTime)} [${p.source}]`)
}
fs.writeFileSync(`${OUTPUT_DIR}/endtime_backfill_report.txt`, out.join('\n'))
console.log(`\nSaved: ${OUTPUT_DIR}/endtime_backfill_plan.json, endtime_backfill_report.txt`)

await conn.end()
