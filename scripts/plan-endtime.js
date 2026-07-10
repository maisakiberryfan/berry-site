import mysql from 'mysql2/promise'
import { dbConfig } from './db-config.cjs'
import fs from 'fs'

const GROUP_TOLERANCE = 5
const MIN_GROUP_SIZE = 2
const MB_CACHE = 'e:/tmp/mb_cache.json'
const OUTPUT_DIR = 'e:/tmp'

// Manual corrections: { streamID, segmentNo, trackNo } → { field: newValue }
const CORRECTIONS = [
  // sec1 confirmed fixes
  { streamID: 'AHomzXlgjCI', segmentNo: 1, trackNo: 9, fixes: { startTime: 2505 } },   // 心拍数#0822 41:58→41:45
  { streamID: 'fTzUZ56Hbig', segmentNo: 1, trackNo: 9, fixes: { endTime: 4810 } },
  { streamID: 'APsWa17nmiA', segmentNo: 1, trackNo: 17, fixes: { startTime: 8379 } },
  { streamID: 'mxelTFnDFF4', segmentNo: 1, trackNo: 7, fixes: { startTime: 3240 } },
  // sec2 layer1 fixes
  { streamID: '42suuMXG2Gw', segmentNo: 1, trackNo: 2, fixes: { startTime: 3147, endTime: 3423 } },  // いけないボーダーライン 52:27~57:03
  { streamID: 'wqIecr8Ly0s', segmentNo: 1, trackNo: 16, fixes: { endTime: 7733 } },    // トイレの神様 end→2:08:53
  { streamID: 'wqIecr8Ly0s', segmentNo: 1, trackNo: 17, fixes: { startTime: 7742 } },  // M start→2:09:02
  { streamID: 'QI9kRIyFS78', segmentNo: 1, trackNo: 14, fixes: { startTime: 6212 } },  // KissHug start→1:43:32
  { streamID: 'q7iim-JebUU', segmentNo: 1, trackNo: 16, fixes: { songID: 234 } },      // 君色に染まる(235)→君色シグナル(234)
  // sec2 layer1 fixes — #8~#20
  // #8 クリスマスイブ→クリスマスソング: user已修正
  { streamID: 'VTBJnZi04Lg', segmentNo: 1, trackNo: 19, fixes: { startTime: 9198 } },  // #9 クリスマスソング start→2:33:18
  { streamID: 'GhfEtf30r8w', segmentNo: 1, trackNo: 51, fixes: { startTime: 22213 } }, // #10 紅蓮華 start→6:10:13
  // #11 最上級にかわいいの！→わたしの一番かわいいところ: user已修正
  { streamID: 'xjBl1sNDW68', segmentNo: 1, trackNo: 11, fixes: { startTime: 4692 } },  // #12 謎 start→1:18:12
  { streamID: 'IJ9ZOCMwaUo', segmentNo: 1, trackNo: 23, fixes: { startTime: 10664, endTime: 10941 } }, // #13 ハロ/ハワユ 2:57:44~3:02:21
  { streamID: '6JcIj-P7qtU', segmentNo: 2, trackNo: 2, fixes: { songID: 124 } },       // #14 First Love(676)→Everything(124)
  { streamID: '6JcIj-P7qtU', segmentNo: 2, trackNo: 3, fixes: { songID: 676 } },       // #14 Everything(124)→First Love(676)
  { streamID: 'qdntQum8KoQ', segmentNo: 1, trackNo: 1, fixes: { endTime: 1398 } },     // #15 ファンサ end→23:18
  // #16 promise→Precious: user已修正
  { streamID: 'jCa3xQ4Y814', segmentNo: 1, trackNo: 10, fixes: { startTime: 5546 } },  // #17 炎 start→1:32:26
  // #18 ユメクイ: 版權封鎖無法確認
  { streamID: 'yVKeKLNYulw', segmentNo: 1, trackNo: 15, fixes: { startTime: 7196 } },  // #19 勇気100% start→1:59:56
  // #20 ロケットビート: 傳輸問題但時軸正確，不需修正
]

const conn = await mysql.createConnection(dbConfig('mbdb'))

const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// === Step 1: Cluster analysis ===
const [records] = await conn.query(`
  SELECT s.songID, sl.songName, sl.artist, sl.duration as currentDur,
         s.streamID, s.segmentNo, s.trackNo,
         CAST(s.endTime AS SIGNED) - CAST(s.startTime AS SIGNED) as actual,
         st.time
  FROM setlist_ori s
  JOIN songlist sl ON s.songID = sl.songID
  LEFT JOIN streamlist st ON s.streamID = st.streamID
  WHERE s.startTime IS NOT NULL AND s.endTime IS NOT NULL
    AND CAST(s.endTime AS SIGNED) - CAST(s.startTime AS SIGNED) > 0
  ORDER BY s.songID, st.time, s.streamID
`)

const songs = new Map()
for (const r of records) {
  if (!songs.has(r.songID)) {
    songs.set(r.songID, {
      songID: r.songID, songName: r.songName, artist: r.artist,
      currentDur: Number(r.currentDur), entries: []
    })
  }
  songs.get(r.songID).entries.push({
    streamID: r.streamID, segmentNo: r.segmentNo, trackNo: r.trackNo,
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
      const groupAvg = group.reduce((a, e) => a + e.actual, 0) / group.length
      if (Math.abs(sorted[j].actual - groupAvg) <= GROUP_TOLERANCE) {
        group.push(sorted[j])
        used.add(j)
      }
    }
    groups.push(group)
  }
  const validGroups = groups.filter(g => g.length >= MIN_GROUP_SIZE)
  const outliers = entries.filter(e => !validGroups.some(g => g.includes(e)))
  for (const g of validGroups) g.sort((a, b) => a.date.localeCompare(b.date))
  validGroups.sort((a, b) => a[0].date.localeCompare(b[0].date))
  return { validGroups, outliers }
}

// Classify songs into sec1/sec2/other
const sec1Songs = new Set() // multi-group
const sec2Songs = new Set() // single group + outliers
const otherSongs = new Set() // single group, no outliers / single entry

for (const [songID, song] of songs) {
  const { validGroups, outliers } = clusterEntries(song.entries)
  if (validGroups.length >= 2) {
    sec1Songs.add(songID)
  } else if (validGroups.length === 1 && outliers.length > 0) {
    sec2Songs.add(songID)
  } else {
    otherSongs.add(songID)
  }
}
console.log(`Songs: sec1=${sec1Songs.size}, sec2=${sec2Songs.size}, other=${otherSongs.size}`)

// Build per-song cluster info (with outlier tracking)
const songClusters = new Map()
for (const [songID, song] of songs) {
  const { validGroups, outliers } = clusterEntries(song.entries)
  const groupInfo = validGroups.map(g => {
    const avg = Math.round(g.reduce((a, e) => a + e.actual, 0) / g.length)
    const dateStart = g[0].date
    const dateEnd = g[g.length - 1].date
    return { avg, count: g.length, dateStart, dateEnd }
  })
  const singleVal = song.entries.length === 1 ? song.entries[0].actual : null
  songClusters.set(songID, {
    songName: song.songName, artist: song.artist,
    groups: groupInfo, singleVal, totalEntries: song.entries.length,
    outliers: outliers.map(o => ({
      streamID: o.streamID, segmentNo: o.segmentNo, trackNo: o.trackNo,
      actual: o.actual, date: o.date,
      diff: groupInfo.length > 0 ? o.actual - groupInfo[0].avg : null
    }))
  })
}

// === Step 2: Get records needing endTime ===
const [missing] = await conn.query(`
  SELECT s.streamID, s.segmentNo, s.trackNo, s.songID, s.startTime,
         sl.songName, sl.artist, st.time
  FROM setlist_ori s
  JOIN songlist sl ON s.songID = sl.songID
  LEFT JOIN streamlist st ON s.streamID = st.streamID
  WHERE s.endTime IS NULL AND s.startTime IS NOT NULL
  ORDER BY st.time, s.streamID, s.segmentNo, s.trackNo
`)
console.log(`Total need endTime: ${missing.length}`)

let mbCache = {}
if (fs.existsSync(MB_CACHE)) {
  mbCache = JSON.parse(fs.readFileSync(MB_CACHE, 'utf-8'))
}

// === Step 3: sec1 only — multi-group songs ===
const sec1Auto = []
const sec1Manual = []

for (const r of missing) {
  if (!sec1Songs.has(r.songID)) continue
  const streamDate = r.time ? new Date(r.time).toISOString().slice(0, 10) : null
  const cluster = songClusters.get(r.songID)
  const { groups } = cluster

  const base = {
    streamID: r.streamID, segmentNo: r.segmentNo, trackNo: r.trackNo,
    songID: r.songID, songName: r.songName, artist: r.artist,
    startTime: r.startTime, streamDate
  }

  // Match to a group by date range
  let matched = null
  if (streamDate) {
    for (const g of groups) {
      if (streamDate >= g.dateStart && streamDate <= g.dateEnd) {
        matched = g
        break
      }
    }
  }

  if (matched) {
    sec1Auto.push({ ...base, duration: matched.avg, endTime: r.startTime + matched.avg,
      source: `group(${matched.avg}s×${matched.count} ${matched.dateStart}~${matched.dateEnd})` })
    continue
  }

  const first = groups[0]
  const last = groups[groups.length - 1]

  if (!streamDate) {
    sec1Manual.push({ ...base, reason: 'no_stream_date', groups, estEndTime: null })
  } else if (streamDate < first.dateStart) {
    // Before all groups — use earliest group (confirmed OK by user)
    sec1Auto.push({ ...base, duration: first.avg, endTime: r.startTime + first.avg,
      source: `earliest_group(${first.avg}s×${first.count} ${first.dateStart}~${first.dateEnd})` })
  } else if (streamDate > last.dateEnd) {
    sec1Auto.push({ ...base, duration: last.avg, endTime: r.startTime + last.avg,
      source: `latest_group(${last.avg}s×${last.count} ${last.dateStart}~${last.dateEnd})` })
  } else {
    // Between groups — need human judgment
    let before = null, after = null
    for (let i = 0; i < groups.length - 1; i++) {
      if (streamDate > groups[i].dateEnd && streamDate < groups[i + 1].dateStart) {
        before = groups[i]
        after = groups[i + 1]
        break
      }
    }
    sec1Manual.push({ ...base, reason: 'between_groups', groups,
      estEndTime: null,
      before: before ? `${before.avg}s (${before.dateStart}~${before.dateEnd})` : null,
      after: after ? `${after.avg}s (${after.dateStart}~${after.dateEnd})` : null })
  }
}

// Count sec2/other/no-history for summary
let sec2Count = 0, otherCount = 0, noHistoryCount = 0
for (const r of missing) {
  if (sec1Songs.has(r.songID)) continue
  if (sec2Songs.has(r.songID)) sec2Count++
  else if (otherSongs.has(r.songID)) otherCount++
  else noHistoryCount++
}

console.log(`\n=== sec1 results ===`)
console.log(`  Auto: ${sec1Auto.length}`)
console.log(`  Manual: ${sec1Manual.length}`)
console.log(`\n=== Not yet processed ===`)
console.log(`  sec2 (has outliers): ${sec2Count} records (${sec2Songs.size} songs)`)
console.log(`  other (single group): ${otherCount} records`)
console.log(`  no history: ${noHistoryCount} records`)

// === Save sec1 plan ===
const sec1Plan = {
  generated: new Date().toISOString(),
  section: 'sec1 — multi-group songs',
  summary: {
    auto: sec1Auto.length,
    manual: sec1Manual.length,
    corrections: CORRECTIONS.length
  },
  corrections: CORRECTIONS,
  auto: sec1Auto,
  manual: sec1Manual
}
fs.writeFileSync(`${OUTPUT_DIR}/sec1_plan.json`, JSON.stringify(sec1Plan, null, 2))

// === sec1 report ===
const out = []
out.push(`sec1 補填計畫（多版本歌曲）— ${new Date().toISOString().slice(0, 10)}`)
out.push('='.repeat(80))
out.push(`自動補填: ${sec1Auto.length} 筆`)
out.push(`需人工判斷: ${sec1Manual.length} 筆`)
out.push(`手動修正: ${CORRECTIONS.length} 筆`)
out.push('')

out.push('\n' + '='.repeat(80))
out.push(`手動修正 (${CORRECTIONS.length} 筆)`)
out.push('='.repeat(80) + '\n')
for (const c of CORRECTIONS) {
  const fixStr = Object.entries(c.fixes).map(([k, v]) => `${k}=${v}`).join(', ')
  out.push(`  ${c.streamID} seg${c.segmentNo} #${c.trackNo} → ${fixStr}`)
}

if (sec1Manual.length > 0) {
  out.push('\n' + '='.repeat(80))
  out.push(`需人工判斷 (${sec1Manual.length} 筆)`)
  out.push('='.repeat(80) + '\n')
  for (const r of sec1Manual) {
    out.push(`${r.songName} / ${r.artist}  (songID=${r.songID})`)
    out.push(`  stream: ${r.streamID}  #${r.trackNo}  date=${r.streamDate}  startTime=${r.startTime}`)
    out.push(`  reason: ${r.reason}`)
    if (r.before) out.push(`  前組: ${r.before}`)
    if (r.after) out.push(`  後組: ${r.after}`)
    if (r.groups) {
      for (const g of r.groups) {
        out.push(`    組: avg=${g.avg}s (${fmt(g.avg)}) n=${g.count}  ${g.dateStart}~${g.dateEnd}`)
      }
    }
    out.push(`  https://www.youtube.com/watch?v=${r.streamID}&t=${r.startTime}s`)
    out.push('')
  }
}

out.push('\n' + '='.repeat(80))
out.push(`自動補填明細 (${sec1Auto.length} 筆)`)
out.push('='.repeat(80) + '\n')
// Group by songID
const bySong = new Map()
for (const r of sec1Auto) {
  if (!bySong.has(r.songID)) bySong.set(r.songID, [])
  bySong.get(r.songID).push(r)
}
for (const [songID, entries] of bySong) {
  const first = entries[0]
  const cluster = songClusters.get(songID)
  out.push(`${first.songName} / ${first.artist}  (songID=${songID})  ${entries.length}筆`)
  out.push(`  分組: ${cluster.groups.map(g => `${g.avg}s(${fmt(g.avg)})×${g.count} ${g.dateStart}~${g.dateEnd}`).join(' | ')}`)
  for (const r of entries) {
    out.push(`  ${r.streamID} #${r.trackNo} ${r.streamDate} start=${r.startTime} → end=${r.endTime} (${fmt(r.duration)}) [${r.source.split('(')[0]}]`)
  }
  out.push('')
}

fs.writeFileSync(`${OUTPUT_DIR}/sec1_plan_report.txt`, out.join('\n'))
console.log(`\nSaved: sec1_plan.json, sec1_plan_report.txt`)

// === Save sec2 outlier list (for next phase) ===
const sec2Outliers = []
for (const songID of sec2Songs) {
  const cluster = songClusters.get(songID)
  const song = songs.get(songID)
  sec2Outliers.push({
    songID, songName: cluster.songName, artist: cluster.artist,
    groups: cluster.groups,
    outliers: cluster.outliers,
    totalEntries: cluster.totalEntries
  })
}
sec2Outliers.sort((a, b) => a.songID - b.songID)
fs.writeFileSync(`${OUTPUT_DIR}/sec2_outliers.json`, JSON.stringify(sec2Outliers, null, 2))
console.log(`Saved: sec2_outliers.json (${sec2Outliers.length} songs, ${sec2Outliers.reduce((a, s) => a + s.outliers.length, 0)} outliers)`)

// === sec2 layer2+3 reports ===
async function getContext(streamID, segmentNo, trackNo) {
  const [rows] = await conn.query(`
    SELECT s.trackNo, s.startTime, s.endTime, sl.songName
    FROM setlist_ori s
    JOIN songlist sl ON s.songID = sl.songID
    WHERE s.streamID = ? AND s.segmentNo = ?
      AND s.trackNo BETWEEN ? AND ?
    ORDER BY s.trackNo
  `, [streamID, segmentNo, trackNo - 1, trackNo + 1])
  return rows
}

function fmtLine(r) {
  const st = Number(r.startTime), et = Number(r.endTime)
  const dur = et - st
  return `     #${r.trackNo} ${fmt(st)}~${fmt(et)} (${dur}s) ${r.songName}`
}

async function generateLayerReport(label, minDiff, maxDiff, filename) {
  const lines = []
  let idx = 0
  for (const song of sec2Outliers) {
    for (const o of song.outliers) {
      const absDiff = Math.abs(o.diff)
      if (absDiff <= minDiff || absDiff > maxDiff) continue
      idx++
      const groupAvg = song.groups[0].avg
      const diffLabel = o.diff > 0 ? `長了${absDiff}s` : `短了${absDiff}s`
      lines.push(`#${idx}  ${song.songName} / ${song.artist}  (songID=${song.songID})`)
      lines.push(`  group avg=${groupAvg}s (${fmt(groupAvg)})  n=${song.groups[0].count}`)
      lines.push(`  outlier: ${o.streamID} seg${o.segmentNo} #${o.trackNo}  ${o.date}`)
      // Get actual start/end from DB
      const [detail] = await conn.query(`
        SELECT startTime, endTime FROM setlist_ori
        WHERE streamID = ? AND segmentNo = ? AND trackNo = ?
      `, [o.streamID, o.segmentNo, o.trackNo])
      const st = detail.length > 0 ? Number(detail[0].startTime) : null
      const et = detail.length > 0 ? Number(detail[0].endTime) : null
      if (st != null && et != null) {
        lines.push(`  start=${st} (${fmt(st)})  end=${et} (${fmt(et)})  actual=${o.actual}s (${fmt(o.actual)})  ${diffLabel}`)
        lines.push(`  start: https://www.youtube.com/watch?v=${o.streamID}&t=${st}s`)
        lines.push(`  end:   https://www.youtube.com/watch?v=${o.streamID}&t=${et}s`)
      } else {
        lines.push(`  actual=${o.actual}s (${fmt(o.actual)})  ${diffLabel}`)
      }
      // Context
      const ctx = await getContext(o.streamID, o.segmentNo, o.trackNo)
      if (ctx.length > 0) {
        lines.push(`  前後曲:`)
        for (const c of ctx) {
          const prefix = Number(c.trackNo) === o.trackNo ? ' >>> ' : '     '
          const cst = Number(c.startTime), cet = Number(c.endTime)
          const cdur = cet - cst
          lines.push(`${prefix}#${c.trackNo} ${fmt(cst)}~${fmt(cet)} (${cdur}s) ${c.songName}`)
        }
      }
      lines.push('')
    }
  }
  const report = [`sec2 outliers — ${label} (${idx} 筆)`, '='.repeat(80), ...lines]
  fs.writeFileSync(`${OUTPUT_DIR}/${filename}`, report.join('\n'))
  console.log(`Saved: ${filename} (${idx} 筆)`)
  return idx
}

const l2 = await generateLayerReport('30s < |diff| ≤ 60s', 30, 60, 'sec2_layer2_30to60s.txt')
const l3 = await generateLayerReport('10s < |diff| ≤ 30s', 10, 30, 'sec2_layer3_10to30s.txt')
console.log(`Layer2: ${l2}, Layer3: ${l3}`)

await conn.end()
