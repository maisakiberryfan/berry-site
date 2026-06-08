/**
 * 平均曲長推算 → 回填 endTime
 * 用 songlist.duration（平均演唱秒數）推算缺失的 endTime
 *
 * 用法:
 *   node scripts/backfill-endtime.js --dry-run              # 全部（只輸出不寫入）
 *   node scripts/backfill-endtime.js --stream 0c827KwIU_U   # 單場
 *   node scripts/backfill-endtime.js                        # 全部寫入
 *   node scripts/backfill-endtime.js --missing              # 列出無曲長的 89 首（查 MusicBrainz）
 */
import mysql from 'mysql2/promise'

const DRY_RUN = process.argv.includes('--dry-run')
const SHOW_MISSING = process.argv.includes('--missing')
const STREAM_FLAG = process.argv.indexOf('--stream')
const SINGLE_STREAM = STREAM_FLAG !== -1 ? process.argv[STREAM_FLAG + 1] : null

const conn = await mysql.createConnection({
  host: '163.44.98.136', port: 8081, user: 'root', password: '***REMOVED***', database: 'mbdb',
  ssl: { rejectUnauthorized: false }
})

const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

// ============================================================
// --missing: List songs without duration, query MusicBrainz
// ============================================================

if (SHOW_MISSING) {
  const [rows] = await conn.query(`
    SELECT s.songID, sl.songName, sl.artist, COUNT(*) as cnt,
           GROUP_CONCAT(DISTINCT CONCAT(s.streamID, '#', s.trackNo, '@', s.startTime) SEPARATOR '|') as locations
    FROM setlist_ori s
    LEFT JOIN songlist sl ON s.songID = sl.songID
    WHERE s.startTime IS NOT NULL AND s.endTime IS NULL AND sl.duration IS NULL
    GROUP BY s.songID, sl.songName, sl.artist
    ORDER BY cnt DESC, sl.songName
  `)

  console.log(`=== ${rows.length} songs without duration (${rows.reduce((a, r) => a + r.cnt, 0)} setlist entries) ===\n`)

  for (const r of rows) {
    // Query MusicBrainz
    let mbDur = null
    try {
      const q = encodeURIComponent(`recording:"${r.songName}" AND artist:"${r.artist}"`)
      const resp = await fetch(
        `https://musicbrainz.org/ws/2/recording?query=${q}&fmt=json&limit=5`,
        { headers: { 'User-Agent': 'BerryBackfill/1.0 (m-b.win)' } }
      )
      const data = await resp.json()
      const rec = (data.recordings ?? []).find(x => x.length && x.score >= 80)
      if (rec) mbDur = Math.round(rec.length / 1000)
      await new Promise(r => setTimeout(r, 1100)) // rate limit
    } catch {}

    const mbStr = mbDur ? `${mbDur}s (${fmt(mbDur)})` : 'NOT FOUND'
    console.log(`songID=${r.songID}  ${r.songName} / ${r.artist}  (${r.cnt}x)  MB: ${mbStr}`)

    // Show each location with estimated endTime
    for (const loc of r.locations.split('|')) {
      const [streamTrack, startStr] = loc.split('@')
      const [streamID, trackNo] = streamTrack.split('#')
      const start = parseInt(startStr)
      const estEnd = mbDur ? start + mbDur : null
      console.log(`    ${streamID} #${trackNo}  start=${start}s  estEnd=${estEnd ?? '?'}s  https://www.youtube.com/watch?v=${streamID}&t=${estEnd ?? start}`)
    }
  }

  await conn.end()
  process.exit(0)
}

// ============================================================
// Main: backfill endTime using songlist.duration
// ============================================================

// Query missing endTime entries with duration from songlist
let query = `
  SELECT s.streamID, s.trackNo, s.segmentNo, s.startTime, s.songID,
         sl.songName, sl.duration
  FROM setlist_ori s
  LEFT JOIN songlist sl ON s.songID = sl.songID
  WHERE s.startTime IS NOT NULL AND s.endTime IS NULL
`
const params = []

if (SINGLE_STREAM) {
  query += ' AND s.streamID = ?'
  params.push(SINGLE_STREAM)
}

query += ' ORDER BY s.streamID, s.segmentNo, s.trackNo'

const [rows] = await conn.query(query, params)

console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}Found ${rows.length} songs needing endTime`)

let updated = 0, skipped = 0, noDuration = 0
let currentStream = null

for (const row of rows) {
  if (row.streamID !== currentStream) {
    currentStream = row.streamID
    const streamSongs = rows.filter(r => r.streamID === currentStream)
    const withDur = streamSongs.filter(r => r.duration).length
    console.log(`\n${currentStream} (${withDur}/${streamSongs.length} have duration)`)
  }

  if (!row.duration) {
    console.log(`  #${row.trackNo} ${(row.songName ?? '?').slice(0, 25).padEnd(25)} NO DURATION`)
    noDuration++
    continue
  }

  const estEndTime = row.startTime + row.duration
  const dur = row.duration

  // Sanity check
  if (dur < 60 || dur > 600) {
    console.log(`  #${row.trackNo} ${(row.songName ?? '?').slice(0, 25).padEnd(25)} SKIP (duration ${dur}s out of range)`)
    skipped++
    continue
  }

  console.log(`  #${row.trackNo} ${(row.songName ?? '?').slice(0, 25).padEnd(25)} ${fmt(row.startTime)} → ${fmt(estEndTime)} (${dur}s)`)

  if (!DRY_RUN) {
    await conn.query(
      'UPDATE setlist_ori SET endTime = ? WHERE streamID = ? AND segmentNo = ? AND trackNo = ? AND endTime IS NULL',
      [estEndTime, row.streamID, row.segmentNo, row.trackNo]
    )
  }
  updated++
}

console.log()
console.log(`Done! Updated: ${updated}, Skipped: ${skipped}, No duration: ${noDuration}`)

await conn.end()
