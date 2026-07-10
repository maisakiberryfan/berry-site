import { fetchWikiSongsByDate } from 'file:///e:/website/berry-site/src/utils/wiki-verifier.js';
import mysql from 'mysql2/promise';
import { dbConfig } from './db-config.cjs'
import fs from 'fs';

const conn = await mysql.createConnection({ ...dbConfig('mbdb') });

const wikiMap = await fetchWikiSongsByDate();

function norm(name) {
  return name
    // Strip wiki formatting artifacts
    .replace(/^\[\[/, '')
    // Strip @ suffix (wiki first-time marker)
    .replace(/@[^@]*$/, '')
    // Strip trailing bracket suffixes: ［混三］, [xxx], 【xxx】
    .replace(/[\[［【][^\]］】]+[\]］】]$/g, '')
    // Strip trailing disambiguation parentheses: 奏(かなで) → 奏
    .replace(/[（(][^)）]+[)）]$/g, '')
    // Strip trailing version suffixes: -Yui Ballade-, -MISS MACROSS 2059-
    .replace(/-[^-]+-$/g, '')
    // Strip trailing "10th ANNIVERSARY MIX" etc.
    .replace(/\s*\d+th\s+ANNIVERSARY.*$/i, '')
    // Full-width → half-width alphanumeric + punctuation
    .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // Normalize wave dashes
    .replace(/[〜～~]/g, '~')
    // Normalize hearts/stars/music notes
    .replace(/[♡♥❤☆★♪♫♬]/g, '')
    // Normalize katakana ノ ↔ hiragana の
    .replace(/ノ/g, 'の')
    // Normalize ウ ↔ ー at end
    .replace(/ウ$/g, 'ー')
    // Normalize small kana: ッ↔っ, ァ↔ぁ etc.
    .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    // Normalize quotes
    .replace(/[\u2018\u2019\u0060\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033\u301d\u301e]/g, '"')
    // Remove all spaces
    .replace(/[\s\u3000]+/g, '')
    // Remove middle dots
    .replace(/[・·]/g, '')
    // Remove trailing period
    .replace(/[.。]$/g, '')
    // Remove punctuation
    .replace(/[!?！？、]/g, '')
    // Normalize dashes
    .replace(/[‐‑–—―−]/g, '-')
    // Normalize Roman numerals
    .replace(/Ⅱ/gi, 'ii').replace(/Ⅲ/gi, 'iii')
    .trim()
    .toLowerCase();
}

// Get singing streams only
const [streams] = await conn.query(
  "SELECT streamID, time, title, categories FROM streamlist WHERE setlistComplete = true ORDER BY time DESC"
);

const singingStreams = streams.filter(s => {
  try {
    const cats = typeof s.categories === 'string' ? JSON.parse(s.categories) : s.categories;
    return cats?.some(c => c.includes('歌枠'));
  } catch { return false; }
});

// Group by JST date
const byDate = new Map();
for (const s of singingStreams) {
  const d = new Date(s.time);
  const jst = new Date(d.getTime() + 9*60*60*1000);
  const dateStr = jst.getUTCFullYear() + '/' + String(jst.getUTCMonth()+1).padStart(2,'0') + '/' + String(jst.getUTCDate()).padStart(2,'0');
  if (!byDate.has(dateStr)) byDate.set(dateStr, []);
  byDate.get(dateStr).push(s);
}

const output = [];
output.push('# Wiki vs DB 歌單差異報告（智慧分析版）');
output.push('生成時間: ' + new Date().toISOString());
output.push(''); // placeholder for stats

let totalVerified = 0, totalMismatch = 0, totalSkipped = 0;

for (const [date, dateStreams] of byDate) {
  const wikiSongs = wikiMap.get(date);
  if (!wikiSongs || wikiSongs.length === 0) { totalSkipped += dateStreams.length; continue; }

  // Get DB songs for each stream
  const streamData = [];
  for (const s of dateStreams) {
    const [rows] = await conn.query(
      'SELECT trackNo, segmentNo, songName FROM setlist WHERE streamID = ? ORDER BY segmentNo, trackNo',
      [s.streamID]
    );
    if (rows.length > 0) streamData.push({ ...s, songs: rows.map(r => r.songName || '') });
  }

  if (streamData.length === 0) { totalSkipped += dateStreams.length; continue; }

  // Assign wiki songs to streams
  let assignments = [];

  if (streamData.length === 1) {
    // Single stream: check overlap first
    const sd = streamData[0];
    let matchCount = 0;
    for (const dbName of sd.songs) {
      if (wikiSongs.some(w => norm(w) === norm(dbName))) matchCount++;
    }
    const overlap = matchCount / Math.max(sd.songs.length, 1);
    if (overlap < 0.3) {
      totalSkipped++;
      continue; // wiki songs belong to a different stream
    }
    assignments = [{ stream: sd, wikiSlice: wikiSongs }];
  } else {
    // Multi-stream: sequential split by time order
    streamData.sort((a, b) => new Date(a.time) - new Date(b.time));
    let offset = 0;
    for (const sd of streamData) {
      const slice = wikiSongs.slice(offset, offset + sd.songs.length);
      let matchCount = 0;
      for (const dbName of sd.songs) {
        if (slice.some(w => norm(w) === norm(dbName))) matchCount++;
      }
      const overlap = matchCount / Math.max(sd.songs.length, 1);
      if (overlap >= 0.3) {
        assignments.push({ stream: sd, wikiSlice: slice });
        offset += sd.songs.length;
      } else {
        totalSkipped++;
      }
    }
  }

  for (const { stream, wikiSlice } of assignments) {
    const dbSongs = stream.songs;
    const wikiS = wikiSlice;
    const normDB = dbSongs.map(s => norm(s));
    const normWiki = wikiS.map(s => norm(s));

    // Find songs only in DB or only in Wiki (by normalized name)
    // Handle duplicates correctly
    const dbCounts = new Map();
    normDB.forEach(n => dbCounts.set(n, (dbCounts.get(n) || 0) + 1));
    const wikiCounts = new Map();
    normWiki.forEach(n => wikiCounts.set(n, (wikiCounts.get(n) || 0) + 1));

    const onlyInDB = [];
    const seen = new Map();
    for (let i = 0; i < normDB.length; i++) {
      const n = normDB[i];
      const seenCount = (seen.get(n) || 0) + 1;
      seen.set(n, seenCount);
      if (seenCount > (wikiCounts.get(n) || 0)) {
        onlyInDB.push({ pos: i + 1, name: dbSongs[i] });
      }
    }

    const onlyInWiki = [];
    const seen2 = new Map();
    for (let i = 0; i < normWiki.length; i++) {
      const n = normWiki[i];
      const seenCount = (seen2.get(n) || 0) + 1;
      seen2.set(n, seenCount);
      if (seenCount > (dbCounts.get(n) || 0)) {
        onlyInWiki.push({ pos: i + 1, name: wikiS[i] });
      }
    }

    // Also check for order differences (same songs, different positions)
    const orderDiffs = [];
    if (onlyInDB.length === 0 && onlyInWiki.length === 0 && dbSongs.length === wikiS.length) {
      for (let i = 0; i < normDB.length; i++) {
        if (normDB[i] !== normWiki[i]) {
          orderDiffs.push({ pos: i + 1, db: dbSongs[i], wiki: wikiS[i] });
        }
      }
    }

    if (onlyInDB.length === 0 && onlyInWiki.length === 0 && orderDiffs.length === 0) {
      totalVerified++;
      continue;
    }

    if (onlyInDB.length === 0 && onlyInWiki.length === 0 && orderDiffs.length > 0) {
      output.push('## ' + date + ' ' + stream.streamID + ' (DB:' + dbSongs.length + ' / Wiki:' + wikiS.length + ') 順序不同');
      for (const d of orderDiffs) {
        output.push('  #' + d.pos + ' DB: ' + d.db + '  ↔  Wiki: ' + d.wiki);
      }
      output.push('');
      totalMismatch++;
      continue;
    }

    output.push('## ' + date + ' ' + stream.streamID + ' (DB:' + dbSongs.length + ' / Wiki:' + wikiS.length + ')');
    for (const d of onlyInDB) {
      output.push('  DB 多 #' + d.pos + ' ' + d.name);
    }
    for (const w of onlyInWiki) {
      output.push('  DB 漏 (wiki #' + w.pos + ') ' + w.name);
    }
    output.push('');
    totalMismatch++;
  }
}

output[2] = 'verified: ' + totalVerified + ' | mismatches: ' + totalMismatch + ' | skipped: ' + totalSkipped;

await conn.end();
fs.writeFileSync('e:/tmp/wiki-diff-report.txt', output.join('\n'));
console.log('Done: verified=' + totalVerified + ' mismatches=' + totalMismatch + ' skipped=' + totalSkipped);
