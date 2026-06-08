import mysql from 'mysql2/promise'
import fs from 'fs'

const GROUP_TOLERANCE = 5 // ±5s to form a group
const MIN_GROUP_SIZE = 2  // at least 2 entries to be a valid group
const MB_CACHE = 'e:/tmp/mb_cache.json'

const conn = await mysql.createConnection({
  host: '163.44.98.136', port: 8081, user: 'root', password: 'B1rdoi25', database: 'mbdb',
  ssl: { rejectUnauthorized: false }
})

// Get all songs with valid startTime+endTime, include stream date
const [records] = await conn.query(`
  SELECT s.songID, sl.songName, sl.artist, sl.duration as currentDur,
         s.streamID, s.trackNo,
         CAST(s.endTime AS SIGNED) - CAST(s.startTime AS SIGNED) as actual,
         st.time
  FROM setlist_ori s
  JOIN songlist sl ON s.songID = sl.songID
  LEFT JOIN streamlist st ON s.streamID = st.streamID
  WHERE s.startTime IS NOT NULL AND s.endTime IS NOT NULL
    AND CAST(s.endTime AS SIGNED) - CAST(s.startTime AS SIGNED) > 0
  ORDER BY s.songID, st.time, s.streamID
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
    actual: Number(r.actual),
    date: r.time ? new Date(r.time).toISOString().slice(0, 10) : '?'
  })
}

const fmt = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`
const skipRe = /\b(TV|テレビ|short ver|instrumental|off vocal|カラオケ|karaoke)\b/i

// ±5s clustering
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
      // Check if within ±5s of group average
      const groupAvg = group.reduce((a, e) => a + e.actual, 0) / group.length
      if (Math.abs(sorted[j].actual - groupAvg) <= GROUP_TOLERANCE) {
        group.push(sorted[j])
        used.add(j)
      }
    }
    groups.push(group)
  }

  // Valid groups: >= MIN_GROUP_SIZE
  const validGroups = groups.filter(g => g.length >= MIN_GROUP_SIZE)
  const groupedEntries = new Set(validGroups.flat())
  const outliers = entries.filter(e => !groupedEntries.has(e))

  // Sort groups by date of latest entry (newest last)
  for (const g of validGroups) {
    g.sort((a, b) => a.date.localeCompare(b.date))
  }
  validGroups.sort((a, b) => {
    const aLast = a[a.length - 1].date
    const bLast = b[b.length - 1].date
    return aLast.localeCompare(bLast)
  })

  return { groups: validGroups, outliers }
}

// Query MusicBrainz
async function queryMB(songName, artist) {
  try {
    const q = encodeURIComponent(`recording:"${songName}" AND artist:"${artist}"`)
    const resp = await fetch(`https://musicbrainz.org/ws/2/recording?query=${q}&fmt=json&limit=5`, {
      headers: { 'User-Agent': 'BerryBackfill/1.0 (m-b.win)' }
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const recs = (data.recordings ?? []).filter(r => r.length && r.score >= 80)
    const clean = recs.filter(r => !skipRe.test(r.title ?? ''))
    const best = clean.find(r => r.length > 120000) ?? clean[0] ?? recs.find(r => r.length > 120000) ?? recs[0]
    if (best) {
      return {
        dur: Math.round(best.length / 1000),
        title: best.title,
        artist: best['artist-credit']?.[0]?.name ?? '?'
      }
    }
  } catch {}
  return null
}

// Analyze each song
const results = []
for (const [songID, song] of songs) {
  const { groups, outliers } = clusterEntries(song.entries)

  // Latest group's avg = recommended duration
  const latestGroup = groups.length > 0 ? groups[groups.length - 1] : null
  const recommendedDur = latestGroup
    ? Math.round(latestGroup.reduce((a, e) => a + e.actual, 0) / latestGroup.length)
    : Math.round(song.entries.reduce((a, e) => a + e.actual, 0) / song.entries.length)

  results.push({
    songID,
    songName: song.songName,
    artist: song.artist,
    currentDur: song.currentDur,
    recommendedDur,
    groups: groups.map(g => {
      const avg = Math.round(g.reduce((a, e) => a + e.actual, 0) / g.length)
      return { avg, count: g.length, dateRange: `${g[0].date}~${g[g.length-1].date}`, entries: g }
    }),
    outliers,
    total: song.entries.length,
    multiGroup: groups.length > 1,
    changed: recommendedDur !== song.currentDur,
    mb: null
  })
}

// Load MB cache
let mbCache = {}
if (fs.existsSync(MB_CACHE)) {
  mbCache = JSON.parse(fs.readFileSync(MB_CACHE, 'utf-8'))
  console.error(`Loaded MB cache: ${Object.keys(mbCache).length} entries`)
}

let mbChecked = 0, mbFound = 0, mbCached = 0
for (const r of results) {
  mbChecked++
  if (mbChecked % 50 === 0) process.stderr.write(`  ${mbChecked}/${results.length}...\n`)
  const key = `${r.songID}`
  if (mbCache[key] !== undefined) {
    r.mb = mbCache[key]
    mbCached++
  } else {
    r.mb = await queryMB(r.songName, r.artist)
    mbCache[key] = r.mb
    await new Promise(resolve => setTimeout(resolve, 1100))
  }
  if (r.mb) mbFound++
}
fs.writeFileSync(MB_CACHE, JSON.stringify(mbCache, null, 2))
console.error(`MB: found ${mbFound}/${mbChecked} (${mbCached} from cache)`)

// === Output ===
const out = []

// Section 1: Multi-group songs (different versions) — skip single-record songs
const multiGroup = results.filter(r => r.multiGroup && r.total > 1)
out.push(`=== ${multiGroup.length} songs with multiple version groups (±${GROUP_TOLERANCE}s, min ${MIN_GROUP_SIZE}) ===\n`)

for (const r of multiGroup) {
  const mbStr = r.mb ? `MB=${r.mb.dur}s (${fmt(r.mb.dur)}) [${r.mb.title}]` : 'MB=NOT FOUND'
  const flag = r.changed ? ' ← CHANGED' : ''
  out.push(`${r.songName} / ${r.artist}  (songID=${r.songID})`)
  out.push(`  current=${r.currentDur}s  recommended=${r.recommendedDur}s  ${mbStr}${flag}`)
  for (let i = 0; i < r.groups.length; i++) {
    const g = r.groups[i]
    const latest = i === r.groups.length - 1 ? ' ★ latest' : ''
    out.push(`  組${i+1}: avg=${g.avg}s (${fmt(g.avg)})  n=${g.count}  ${g.dateRange}${latest}`)
  }
  if (r.outliers.length > 0) {
    out.push(`  outliers (${r.outliers.length}):`)
    for (const o of r.outliers) {
      out.push(`    ⚠ ${o.streamID} #${o.trackNo}  actual=${o.actual}s (${fmt(o.actual)})  ${o.date}  https://www.youtube.com/watch?v=${o.streamID}`)
    }
  }
  out.push('')
}

// Section 2: Songs with outliers (single group but some don't fit) — skip single-record songs
const withOutliers = results.filter(r => !r.multiGroup && r.outliers.length > 0 && r.total > 1)
out.push(`\n=== ${withOutliers.length} songs with outliers (single group + stray entries) ===\n`)

for (const r of withOutliers) {
  const mbStr = r.mb ? `MB=${r.mb.dur}s (${fmt(r.mb.dur)}) [${r.mb.title}]` : 'MB=NOT FOUND'
  const flag = r.changed ? ' ← CHANGED' : ''
  const g = r.groups[0]
  out.push(`${r.songName} / ${r.artist}  (songID=${r.songID})`)
  out.push(`  current=${r.currentDur}s  recommended=${r.recommendedDur}s  ${mbStr}${flag}`)
  if (g) out.push(`  組1: avg=${g.avg}s (${fmt(g.avg)})  n=${g.count}  ${g.dateRange}`)
  out.push(`  outliers (${r.outliers.length}):`)
  for (const o of r.outliers) {
    out.push(`    ⚠ ${o.streamID} #${o.trackNo}  actual=${o.actual}s (${fmt(o.actual)})  ${o.date}  https://www.youtube.com/watch?v=${o.streamID}`)
  }
  out.push('')
}

// Section 3: ALL songs summary table
out.push(`\n${'='.repeat(120)}`)
out.push(`ALL ${results.length} songs — sorted by songID  (±${GROUP_TOLERANCE}s groups, min ${MIN_GROUP_SIZE})`)
out.push(`${'='.repeat(120)}`)
out.push(`${'ID'.padStart(5)} ${'Song'.padEnd(25)} ${'cur'.padStart(5)} ${'rec'.padStart(5)} ${'MB'.padStart(5)} ${'n'.padStart(4)} ${'grp'.padStart(4)} ${'out'.padStart(4)} ${'diff'.padStart(5)} groups`)
out.push('-'.repeat(120))

results.sort((a, b) => a.songID - b.songID)
let changedCount = 0
for (const r of results) {
  const diff = r.recommendedDur - r.currentDur
  const diffStr = diff !== 0 ? `${diff > 0 ? '+' : ''}${diff}` : ''
  const mbDur = r.mb ? String(r.mb.dur) : '?'
  const mark = r.multiGroup ? ' M' : r.outliers.length > 0 ? ' *' : ''
  if (r.changed) changedCount++
  const groupStr = r.groups.map((g, i) => `${g.avg}s×${g.count}`).join(' | ')
  out.push(`${String(r.songID).padStart(5)} ${(r.songName||'?').slice(0,25).padEnd(25)} ${String(r.currentDur).padStart(5)} ${String(r.recommendedDur).padStart(5)} ${mbDur.padStart(5)} ${String(r.total).padStart(4)} ${String(r.groups.length).padStart(4)} ${String(r.outliers.length).padStart(4)} ${diffStr.padStart(5)}${mark} ${groupStr}`)
}

out.push(`\nTotal: ${results.length} songs`)
out.push(`  ${changedCount} with changed duration`)
out.push(`  ${multiGroup.length} with multiple groups (M)`)
out.push(`  ${withOutliers.length} with outliers (*)`)
out.push(`  MB found: ${mbFound}/${mbChecked}`)

fs.writeFileSync('e:/tmp/duration_audit_result.txt', out.join('\n'))
console.log('Done! Saved to e:/tmp/duration_audit_result.txt')

await conn.end()
