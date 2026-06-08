import mysql from 'mysql2/promise'

const conn = await mysql.createConnection({
  host: '163.44.98.136', port: 8081, user: 'root', password: 'B1rdoi25', database: 'mbdb',
  ssl: { rejectUnauthorized: false }
})

// Get all songs with at least one valid startTime+endTime record
const [records] = await conn.query(`
  SELECT s.songID, sl.songName, sl.artist, sl.duration as currentDur,
         s.streamID, s.trackNo,
         CAST(s.endTime AS SIGNED) - CAST(s.startTime AS SIGNED) as actual
  FROM setlist_ori s
  JOIN songlist sl ON s.songID = sl.songID
  WHERE s.startTime IS NOT NULL AND s.endTime IS NOT NULL
    AND CAST(s.endTime AS SIGNED) - CAST(s.startTime AS SIGNED) > 0
  ORDER BY s.songID, s.streamID
`)

// Group by songID
const songs = new Map()
for (const r of records) {
  if (!songs.has(r.songID)) {
    songs.set(r.songID, {
      songID: r.songID,
      songName: r.songName,
      artist: r.artist,
      currentDur: Number(r.currentDur),
      entries: []
    })
  }
  songs.get(r.songID).entries.push({
    streamID: r.streamID,
    trackNo: r.trackNo,
    actual: Number(r.actual)
  })
}

const fmt = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`

// Analyze each song
const results = []
for (const [songID, song] of songs) {
  const actuals = song.entries.map(e => e.actual).sort((a,b) => a - b)
  const median = actuals[Math.floor(actuals.length / 2)]
  const outliers = song.entries.filter(e => Math.abs(e.actual - median) > 30)
  const clean = song.entries.filter(e => Math.abs(e.actual - median) <= 30)
  const cleanAvg = clean.length > 0
    ? Math.round(clean.reduce((a, e) => a + e.actual, 0) / clean.length)
    : Math.round(actuals.reduce((a,b) => a+b, 0) / actuals.length)

  results.push({
    songID,
    songName: song.songName,
    artist: song.artist,
    currentDur: song.currentDur,
    cleanAvg,
    median,
    total: song.entries.length,
    outlierCount: outliers.length,
    outliers: outliers.map(e => ({ ...e, diff: e.actual - median })),
    changed: cleanAvg !== song.currentDur
  })
}

// Sort: songs with outliers first, then by songID
results.sort((a, b) => (b.outlierCount - a.outlierCount) || (a.songID - b.songID))

// Output: songs WITH outliers (detailed)
const withOutliers = results.filter(r => r.outlierCount > 0)
console.log(`=== ${withOutliers.length} songs with outliers (|actual - median| > 30s) ===\n`)

for (const r of withOutliers) {
  const flag = r.changed ? ' ← CHANGED' : ''
  console.log(`${r.songName} / ${r.artist}  (songID=${r.songID})`)
  console.log(`  current=${r.currentDur}s  cleanAvg=${r.cleanAvg}s  median=${r.median}s  records=${r.total}  outliers=${r.outlierCount}${flag}`)
  for (const o of r.outliers) {
    console.log(`  ⚠ ${o.streamID} #${o.trackNo}  actual=${o.actual}s (${fmt(o.actual)})  diff=${o.diff > 0 ? '+' : ''}${o.diff}s  https://www.youtube.com/watch?v=${o.streamID}`)
  }
  console.log()
}

// Output: ALL songs (summary table)
console.log(`\n${'='.repeat(100)}`)
console.log(`ALL ${results.length} songs — sorted by songID`)
console.log(`${'='.repeat(100)}`)
console.log(`${'ID'.padStart(5)} ${'Song'.padEnd(25)} ${'cur'.padStart(5)} ${'new'.padStart(5)} ${'med'.padStart(5)} ${'n'.padStart(3)} ${'out'.padStart(3)} ${'diff'.padStart(5)}`)
console.log('-'.repeat(80))

// Re-sort by songID for full list
results.sort((a, b) => a.songID - b.songID)
let changedCount = 0
for (const r of results) {
  const diff = r.cleanAvg - r.currentDur
  const diffStr = diff !== 0 ? `${diff > 0 ? '+' : ''}${diff}` : ''
  const mark = r.outlierCount > 0 ? ' *' : ''
  if (r.changed) changedCount++
  console.log(`${String(r.songID).padStart(5)} ${(r.songName||'?').slice(0,25).padEnd(25)} ${String(r.currentDur).padStart(5)} ${String(r.cleanAvg).padStart(5)} ${String(r.median).padStart(5)} ${String(r.total).padStart(3)} ${String(r.outlierCount).padStart(3)} ${diffStr.padStart(5)}${mark}`)
}

console.log(`\nTotal: ${results.length} songs, ${changedCount} with changed duration, ${withOutliers.length} with outliers`)

await conn.end()
