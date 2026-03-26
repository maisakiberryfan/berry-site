/**
 * Wiki 歌單二次校正模組
 * 從 Seesaa Wiki 全曲リスト(軽量版) 抓取資料，與 DB 歌單比對
 */

import { Database } from './database.js'
import { getSecret } from '../platform.js'

const WIKI_URL = 'https://seesaawiki.jp/maisakiberry/d/%c1%b4%b6%ca%a5%ea%a5%b9%a5%c8%28%b7%da%ce%cc%c8%c7%29'

// 延遲天數：歌枠結束後至少等幾天才驗證（給 wiki 更新時間）
const DELAY_DAYS = 7

/**
 * 從 wiki 抓取全曲リスト並按日期分組
 * @returns {Map<string, string[]>} date → song titles
 */
export async function fetchWikiSongsByDate() {
  const response = await fetch(WIKI_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (berry-site wiki-verifier)' }
  })

  if (!response.ok) {
    throw new Error(`Wiki fetch failed: ${response.status}`)
  }

  const buffer = await response.arrayBuffer()
  const text = new TextDecoder('euc-jp').decode(buffer)

  // Parse table rows: <tr>...<td>date</td><td>title</td><td>edit</td>...</tr>
  const songsByDate = new Map()
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let match

  while ((match = rowRegex.exec(text)) !== null) {
    const rowHtml = match[1]
    const cells = []
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
    let cellMatch
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      const cellText = cellMatch[1].replace(/<[^>]+>/g, '').trim()
      cells.push(cellText)
    }

    if (cells.length < 2) continue
    const date = cells[0]
    const title = cells[1]

    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) continue

    const cleaned = decodeHtmlEntities(title.replace(/@$/, '').trim())
    if (!cleaned) continue

    if (!songsByDate.has(date)) {
      songsByDate.set(date, [])
    }
    songsByDate.get(date).push(cleaned)
  }

  return songsByDate
}

/**
 * Decode HTML entities (&#9829; → ♥ etc.)
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

/**
 * Normalize song name for comparison
 */
function normalizeName(name) {
  return name
    // Strip trailing disambiguation parentheses: 奏(かなで) → 奏
    .replace(/[（(][^)）]+[)）]$/g, '')
    // Full-width → half-width alphanumeric + punctuation
    .replace(/[\uff01-\uff5e]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // Normalize wave dashes
    .replace(/[〜～~]/g, '~')
    // Normalize hearts/stars
    .replace(/[♡♥❤☆★♪♫♬]/g, '')
    // Normalize katakana ノ ↔ hiragana の
    .replace(/ノ/g, 'の')
    // Normalize ウ ↔ ー at word boundaries (オーバーフロウ = オーバーフロー)
    .replace(/ウ$/g, 'ー')
    // Normalize quotes/apostrophes/double quotes
    .replace(/[\u2018\u2019\u0060\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033\u301d\u301e″]/g, '"')
    // Normalize spaces (remove all)
    .replace(/[\s　]+/g, '')
    // Normalize dots/bullets/middle dots
    .replace(/[・·]/g, '')
    // Remove trailing punctuation (period, etc.)
    .replace(/[.。]$/g, '')
    // Remove punctuation differences (!, ?, etc.)
    .replace(/[!?！？、]/g, '')
    // Normalize dashes (keep ー for katakana long vowel, only normalize actual dashes)
    .replace(/[‐‑–—―−]/g, '-')
    // Normalize Roman numerals ↔ ASCII (II↔Ⅱ, etc.)
    .replace(/Ⅱ/gi, 'ii').replace(/Ⅲ/gi, 'iii')
    // Normalize ・ in middle of katakana compound words (虹いろ・クマクマ = 虹いろクマクマ)
    // Already removed ・ above
    .trim()
    .toLowerCase()
}

/**
 * Compare a single stream's setlist against wiki data
 * Outputs all non-exact-normalized matches for human review
 */
async function compareStreamWithWiki(streamID, wikiSongs, db) {
  const dbSetlist = await db.query(
    'SELECT trackNo, segmentNo, songName, artist FROM setlist WHERE streamID = ? ORDER BY segmentNo ASC, trackNo ASC',
    [streamID]
  )

  if (dbSetlist.length === 0) {
    return { streamID, status: 'no-setlist', mismatches: [] }
  }

  const dbSongs = dbSetlist.map(row => ({
    trackNo: row.trackNo,
    segmentNo: row.segmentNo,
    songName: row.songName || '',
    artist: row.artist || ''
  }))

  const mismatches = []
  const onlyInWiki = []
  const onlyInDB = []

  const maxLen = Math.max(dbSongs.length, wikiSongs.length)
  for (let i = 0; i < maxLen; i++) {
    const dbSong = dbSongs[i]
    const wikiTitle = wikiSongs[i]

    if (!dbSong && wikiTitle) {
      onlyInWiki.push({ position: i + 1, wikiTitle })
      continue
    }
    if (dbSong && !wikiTitle) {
      onlyInDB.push({ position: i + 1, dbSongName: dbSong.songName, segmentNo: dbSong.segmentNo, trackNo: dbSong.trackNo })
      continue
    }

    // Normalized comparison — any difference goes to human review
    const normDB = normalizeName(dbSong.songName)
    const normWiki = normalizeName(wikiTitle)

    if (normDB !== normWiki) {
      mismatches.push({
        position: i + 1,
        segmentNo: dbSong.segmentNo,
        trackNo: dbSong.trackNo,
        dbSongName: dbSong.songName,
        wikiTitle
      })
    }
  }

  // If wiki simply has fewer songs but all existing ones match,
  // treat as "wiki not yet fully updated" rather than a real mismatch
  const wikiIncomplete = mismatches.length === 0 && onlyInWiki.length === 0 && onlyInDB.length > 0
    && wikiSongs.length < dbSongs.length

  const hasDiff = mismatches.length > 0 || onlyInWiki.length > 0 || (onlyInDB.length > 0 && !wikiIncomplete)
  return {
    streamID,
    status: wikiIncomplete ? 'wiki-incomplete' : (hasDiff ? 'mismatch' : 'match'),
    dbCount: dbSongs.length,
    wikiCount: wikiSongs.length,
    mismatches,
    onlyInWiki,
    onlyInDB
  }
}

/**
 * Convert UTC datetime to JST date string "YYYY/MM/DD"
 */
function toJSTDateString(utcTimeStr) {
  const d = new Date(utcTimeStr)
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const year = jst.getUTCFullYear()
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const day = String(jst.getUTCDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

/**
 * For multi-stream days: calculate overlap score between DB setlist and wiki songs
 */
function calculateOverlap(dbSongNames, wikiSongs) {
  let matches = 0
  for (const dbName of dbSongNames) {
    const normDB = normalizeName(dbName)
    if (wikiSongs.some(w => normalizeName(w) === normDB || normalizeName(w.replace(/\([^)]+\)$/, '').trim()) === normDB)) {
      matches++
    }
  }
  return matches / Math.max(dbSongNames.length, wikiSongs.length, 1)
}

/**
 * Main: verify recent setlists against wiki
 * @param {Object} env
 * @param {Object} options
 * @param {number} options.lookbackDays - 回溯天數（預設 30）
 * @param {string} options.date - 指定日期 "YYYY/MM/DD"（跳過延遲限制）
 * @param {string} options.streamID - 指定 streamID（跳過延遲限制）
 * @returns {Object} { verified, mismatches, skipped, details }
 */
export async function verifyRecentSetlists(env, options = {}) {
  const { lookbackDays = 14, date, streamID } = typeof options === 'number'
    ? { lookbackDays: options } : options

  console.log(`[WIKI] 開始 Wiki 歌單校正 (lookback: ${lookbackDays} days${date ? `, date: ${date}` : ''}${streamID ? `, streamID: ${streamID}` : ''})`)

  const wikiData = await fetchWikiSongsByDate()
  console.log(`[WIKI] 取得 ${wikiData.size} 個配信日`)

  const db = new Database(env)

  let singingStreams

  if (streamID) {
    // 指定 streamID 模式
    const stream = await db.first(
      'SELECT streamID, title, time, categories FROM streamlist WHERE streamID = ?',
      [streamID]
    )
    if (!stream) {
      return { verified: 0, mismatches: 0, skipped: 0, details: [], error: 'Stream not found' }
    }
    singingStreams = [stream]
  } else if (date) {
    // 指定日期模式：找該日所有歌枠
    // date 是 JST，轉換為 UTC 範圍查詢
    const jstDate = new Date(`${date.replace(/\//g, '-')}T00:00:00+09:00`)
    const jstNextDate = new Date(jstDate.getTime() + 24 * 60 * 60 * 1000)
    const streams = await db.query(
      `SELECT streamID, title, time, categories FROM streamlist
       WHERE setlistComplete = true
         AND time >= ? AND time < ?
       ORDER BY time ASC`,
      [jstDate.toISOString(), jstNextDate.toISOString()]
    )
    singingStreams = streams.filter(s => {
      const cats = typeof s.categories === 'string' ? JSON.parse(s.categories) : s.categories
      return cats?.some(c => c.includes('歌枠'))
    })
  } else {
    // 自動模式：查詢 DELAY_DAYS 天前～lookbackDays 天前的未驗證歌枠
    const streams = await db.query(
      `SELECT streamID, title, time, categories FROM streamlist
       WHERE setlistComplete = true
         AND (wikiVerified IS NULL)
         AND time >= DATE_SUB(NOW(), INTERVAL ? DAY)
         AND time <= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY time DESC`,
      [lookbackDays, DELAY_DAYS]
    )

    singingStreams = streams.filter(s => {
      const cats = typeof s.categories === 'string' ? JSON.parse(s.categories) : s.categories
      return cats?.some(c => c.includes('歌枠'))
    })
  }

  if (singingStreams.length === 0) {
    console.log('[WIKI] 無待驗證歌枠')
    return { verified: 0, mismatches: 0, skipped: 0, details: [] }
  }

  console.log(`[WIKI] ${singingStreams.length} 個待驗證歌枠`)

  // Group streams by JST date
  const streamsByDate = new Map()
  for (const stream of singingStreams) {
    const dateStr = toJSTDateString(stream.time)
    if (!streamsByDate.has(dateStr)) {
      streamsByDate.set(dateStr, [])
    }
    streamsByDate.get(dateStr).push(stream)
  }

  let verified = 0
  let mismatchCount = 0
  let skipped = 0
  const details = []

  for (const [dateStr, dateStreams] of streamsByDate) {
    const wikiSongs = wikiData.get(dateStr)

    if (!wikiSongs || wikiSongs.length === 0) {
      console.log(`[WIKI] ${dateStr}: wiki 資料不存在，跳過`)
      skipped += dateStreams.length
      continue
    }

    if (dateStreams.length === 1) {
      const stream = dateStreams[0]
      const result = await compareStreamWithWiki(stream.streamID, wikiSongs, db)
      result.title = stream.title
      result.date = dateStr

      if (result.status === 'match') {
        await db.execute('UPDATE streamlist SET wikiVerified = true WHERE streamID = ?', [stream.streamID])
        verified++
      } else if (result.status === 'wiki-incomplete') {
        console.log(`[WIKI] ${dateStr}: ${stream.streamID} wiki 尚未填完 (DB:${result.dbCount} wiki:${result.wikiCount})，跳過`)
        skipped++
      } else if (result.status === 'mismatch') {
        await db.execute('UPDATE streamlist SET wikiVerified = false WHERE streamID = ?', [stream.streamID])
        mismatchCount++
        details.push(result)
      }
    } else {
      // Multiple streams on same date — match by content overlap
      const streamSetlists = []
      for (const stream of dateStreams) {
        const setlist = await db.query(
          'SELECT songName FROM setlist WHERE streamID = ? ORDER BY segmentNo ASC, trackNo ASC',
          [stream.streamID]
        )
        streamSetlists.push({
          stream,
          songNames: setlist.map(r => r.songName || '')
        })
      }

      const totalDBSongs = streamSetlists.reduce((sum, s) => sum + s.songNames.length, 0)

      if (Math.abs(totalDBSongs - wikiSongs.length) <= 3) {
        let wikiOffset = 0
        for (const { stream, songNames } of streamSetlists) {
          const wikiSlice = wikiSongs.slice(wikiOffset, wikiOffset + songNames.length)
          const overlap = calculateOverlap(songNames, wikiSlice)

          if (overlap >= 0.5) {
            const result = await compareStreamWithWiki(stream.streamID, wikiSlice, db)
            result.title = stream.title
            result.date = dateStr

            if (result.status === 'match') {
              await db.execute('UPDATE streamlist SET wikiVerified = true WHERE streamID = ?', [stream.streamID])
              verified++
            } else if (result.status === 'wiki-incomplete') {
              skipped++
            } else {
              await db.execute('UPDATE streamlist SET wikiVerified = false WHERE streamID = ?', [stream.streamID])
              mismatchCount++
              details.push(result)
            }
            wikiOffset += songNames.length
          } else {
            console.log(`[WIKI] ${dateStr}: ${stream.streamID} overlap 太低 (${(overlap * 100).toFixed(0)}%)，跳過`)
            skipped++
          }
        }
      } else {
        console.log(`[WIKI] ${dateStr}: 多場歌枠曲數不符 (DB:${totalDBSongs} wiki:${wikiSongs.length})，跳過`)
        skipped += dateStreams.length
      }
    }
  }

  console.log(`[WIKI] 完成: verified=${verified}, mismatches=${mismatchCount}, skipped=${skipped}`)
  return { verified, mismatches: mismatchCount, skipped, details }
}

/**
 * Format wiki diff as Discord embed
 */
export function buildWikiDiffEmbed(details) {
  const embeds = []

  for (const diff of details) {
    const fields = []

    if (diff.dbCount !== diff.wikiCount) {
      fields.push({
        name: '曲數差異',
        value: `DB: ${diff.dbCount} / Wiki: ${diff.wikiCount}`,
        inline: true
      })
    }

    if (diff.mismatches.length > 0) {
      const text = diff.mismatches
        .map(m => `#${m.position} (seg${m.segmentNo} #${m.trackNo}) DB: ${m.dbSongName} → Wiki: ${m.wikiTitle}`)
        .join('\n')
      fields.push({
        name: '位置不同',
        value: text.substring(0, 1024),
        inline: false
      })
    }

    if (diff.onlyInWiki.length > 0) {
      const text = diff.onlyInWiki
        .map(m => `#${m.position} ${m.wikiTitle}`)
        .join('\n')
      fields.push({
        name: '只在 Wiki',
        value: text.substring(0, 1024),
        inline: false
      })
    }

    if (diff.onlyInDB.length > 0) {
      const text = diff.onlyInDB
        .map(m => `#${m.position} (seg${m.segmentNo} #${m.trackNo}) ${m.dbSongName}`)
        .join('\n')
      fields.push({
        name: '只在 DB',
        value: text.substring(0, 1024),
        inline: false
      })
    }

    embeds.push({
      title: `⚠️ Wiki 歌單差異 — ${diff.title || diff.streamID}`,
      description: `配信日: ${diff.date}\nStream ID: \`${diff.streamID}\``,
      color: 0xffa500,
      fields,
      timestamp: new Date().toISOString()
    })
  }

  return embeds
}

/**
 * Send wiki diff notification to Discord
 */
export async function sendWikiDiffNotification(env, details) {
  const webhookUrl = getSecret(env, 'DISCORD_WEBHOOK_URL')
  if (!webhookUrl || details.length === 0) return

  const embeds = buildWikiDiffEmbed(details)

  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10)
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: batch })
      })
    } catch (error) {
      console.error(`[WIKI] Discord 通知失敗: ${error.message}`)
    }
  }
}
