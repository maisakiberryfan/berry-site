/**
 * @fileoverview AWS Lambda handler for setlist fuzzy matching
 * Migrated from worker/src/utils/fuzzy-matcher.js
 */

import { Searcher } from 'fast-fuzzy'
import leven from 'leven'

// API URL from environment variable
const BERRY_SITE_API_URL = process.env.BERRY_SITE_API_URL || 'https://d36w2d8blmdfr.cloudfront.net'

// Matching configuration
const CONFIG = {
  threshold: 0.88,
  titleWeight: 0.75,
  artistWeight: 0.25,
}

// ============================================================================
// Data Fetching from Berry Site API
// ============================================================================

/**
 * Fetch aliases data from Berry Site API
 */
async function getAliasesData() {
  const response = await fetch(`${BERRY_SITE_API_URL}/api/aliases/grouped`)

  if (!response.ok) {
    throw new Error(`Aliases API error: ${response.status}`)
  }

  const result = await response.json()

  if (!result.success) {
    throw new Error(result.error?.message || 'Aliases API returned error')
  }

  return result.data
}

/**
 * Fetch songlist data from Berry Site API (optimized format)
 */
async function getSonglistData() {
  const response = await fetch(`${BERRY_SITE_API_URL}/api/songlist/optimized`)

  if (!response.ok) {
    throw new Error(`Songlist API error: ${response.status}`)
  }

  const result = await response.json()

  // Handle both formats: {data: ...} and {success: true, data: ...}
  if (!result.data) {
    throw new Error(result.error?.message || 'Songlist API returned no data')
  }

  return result.data
}

// ============================================================================
// Matching Functions (copied from fuzzy-matcher.js)
// ============================================================================

function normalizeText(text) {
  if (!text) return ''
  let normalized = text.normalize('NFKC')
  normalized = normalized.toLowerCase()
  normalized = normalized.trim().replace(/\s+/g, ' ')
  return normalized
}

function extractJpEn(text) {
  if (!text) return { jp: '', en: '' }

  const parenMatch = text.match(/^(.*?)\s*\((.*?)\)\s*$/)

  if (!parenMatch) {
    if (/^[A-Za-z0-9 '\-!?.,]+$/.test(text.trim())) {
      return { jp: text.trim(), en: text.trim() }
    }
    return { jp: text.trim(), en: '' }
  }

  const base = parenMatch[1].trim()
  const paren = parenMatch[2].trim()

  return { jp: base, en: paren }
}

function parseSetlistLine(line) {
  if (!line || line.length < 3) return null

  let cleaned = line

  if (cleaned.includes('♬セトリ') || cleaned.includes('Set List') ||
      cleaned.includes('setlist') || cleaned.match(/^♬/)) {
    return null
  }

  cleaned = cleaned.replace(/\d+:\d+:\d+\s*~\s*\d+:\d+:\d+\s*/g, '')
  cleaned = cleaned.replace(/^[\d①②③④⑤⑥⑦⑧⑨⑩]+[.|｜|\s]/g, '')
  cleaned = cleaned.trim()

  if (!cleaned || cleaned.length < 3) return null

  let songPart = ''
  let artistPart = ''

  const separators = ['|', '｜', ' - ', '/', '  ', '\t']

  for (const sep of separators) {
    if (cleaned.includes(sep)) {
      const parts = cleaned.split(sep, 2)
      songPart = parts[0].trim()
      artistPart = parts[1] ? parts[1].trim() : ''
      break
    }
  }

  if (!songPart) {
    songPart = cleaned.trim()
  }

  if (!songPart || songPart.length === 0) return null

  const song = extractJpEn(songPart)
  const artist = extractJpEn(artistPart)

  return {
    titleJP: song.jp,
    titleEN: song.en,
    artistJP: artist.jp,
    artistEN: artist.en,
    raw: line
  }
}

function expandAliases(text, aliasMap) {
  if (!text) return []

  const normalized = normalizeText(text)
  const variations = [normalized]

  for (const [key, aliases] of Object.entries(aliasMap)) {
    const normalizedKey = normalizeText(key)

    if (normalized === normalizedKey || normalized.includes(normalizedKey)) {
      variations.push(normalizedKey)
      aliases.forEach(alias => variations.push(normalizeText(alias)))
    } else {
      for (const alias of aliases) {
        const normalizedAlias = normalizeText(alias)
        if (normalized === normalizedAlias || normalized.includes(normalizedAlias)) {
          variations.push(normalizedKey)
          variations.push(...aliases.map(a => normalizeText(a)))
          break
        }
      }
    }
  }

  return [...new Set(variations)]
}

function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0

  const norm1 = normalizeText(str1)
  const norm2 = normalizeText(str2)

  if (norm1 === norm2) return 1.0

  // 直接用 leven 計算，不需要每次 new Searcher
  const maxLen = Math.max(norm1.length, norm2.length)
  if (maxLen === 0) return 0

  const distance = leven(norm1, norm2)
  return Math.max(0, 1 - (distance / maxLen))
}

function calculateArtistScore(parsedSong, dbArtist, aliasesData) {
  if (!dbArtist) return 0

  const inputVariations = [
    ...expandAliases(parsedSong.artistJP, aliasesData.artistAliases || {}),
    ...expandAliases(parsedSong.artistEN, aliasesData.artistAliases || {})
  ].filter(Boolean)

  const dbVariations = expandAliases(dbArtist, aliasesData.artistAliases || {})

  if (inputVariations.length === 0) return 0

  let maxScore = 0
  for (const inputVar of inputVariations) {
    for (const dbVar of dbVariations) {
      const score = calculateSimilarity(inputVar, dbVar)
      maxScore = Math.max(maxScore, score)
    }
  }

  return maxScore
}

function calculateTitleScore(parsedSong, dbTitle, aliasesData) {
  if (!dbTitle) return 0

  const inputVariations = [
    ...expandAliases(parsedSong.titleJP, aliasesData.titleAliases || {}),
    ...expandAliases(parsedSong.titleEN, aliasesData.titleAliases || {})
  ].filter(Boolean)

  const dbVariations = expandAliases(dbTitle, aliasesData.titleAliases || {})

  if (inputVariations.length === 0) return 0

  let maxScore = 0
  for (const inputVar of inputVariations) {
    for (const dbVar of dbVariations) {
      const score = calculateSimilarity(inputVar, dbVar)
      maxScore = Math.max(maxScore, score)
    }
  }

  return maxScore
}

// ============================================================================
// Search Index (預建索引優化)
// ============================================================================

/**
 * 建立歌曲標題的搜索索引
 * 包含原始標題和所有 aliases，用於快速找出候選匹配
 */
function buildSearchIndex(songlistData, aliasesData) {
  const entries = []

  for (const [songID, songData] of Object.entries(songlistData)) {
    const [dbTitle, dbArtist] = songData.split('|').map(s => s?.trim() || '')

    // 加入原始標題
    entries.push({
      songID,
      dbTitle,
      dbArtist,
      searchKey: normalizeText(dbTitle)
    })

    // 加入標題的所有 aliases
    const titleAliases = aliasesData.titleAliases?.[dbTitle] || []
    for (const alias of titleAliases) {
      entries.push({
        songID,
        dbTitle,
        dbArtist,
        searchKey: normalizeText(alias)
      })
    }
  }

  return new Searcher(entries, {
    keySelector: item => item.searchKey,
    threshold: 0.5,  // 較低門檻以獲取更多候選
    returnMatchData: true
  })
}

/**
 * 使用預建索引快速找出最佳匹配
 */
function findBestMatchWithIndex(parsedSong, searcher, aliasesData) {
  // 取得輸入的標題變體（包含 aliases）
  const inputVariations = [
    parsedSong.titleJP,
    parsedSong.titleEN,
    ...expandAliases(parsedSong.titleJP, aliasesData.titleAliases || {}),
    ...expandAliases(parsedSong.titleEN, aliasesData.titleAliases || {})
  ].filter(Boolean)

  if (inputVariations.length === 0) {
    return { songID: "*", score: 0, confidence: "low" }
  }

  // 用所有變體搜索，合併候選
  const candidateMap = new Map()  // songID -> best candidate info

  for (const inputTitle of inputVariations) {
    const results = searcher.search(inputTitle)

    for (const result of results) {
      const { songID, dbTitle, dbArtist } = result.item
      const searchScore = result.score

      // 保留每首歌的最高搜索分數
      if (!candidateMap.has(songID) || candidateMap.get(songID).searchScore < searchScore) {
        candidateMap.set(songID, { songID, dbTitle, dbArtist, searchScore })
      }
    }
  }

  if (candidateMap.size === 0) {
    return { songID: "*", score: 0, confidence: "low" }
  }

  // 對候選做精細計算
  let bestMatch = { songID: "*", score: 0, confidence: "low" }
  const songsByTitle = {}

  for (const candidate of candidateMap.values()) {
    const { songID, dbTitle, dbArtist } = candidate

    // 精細計算 title score
    const titleScore = calculateTitleScore(parsedSong, dbTitle, aliasesData)
    if (titleScore < 0.7) continue

    // 計算 artist score
    const artistScore = calculateArtistScore(parsedSong, dbArtist, aliasesData)

    const combinedScore = titleScore * CONFIG.titleWeight + artistScore * CONFIG.artistWeight

    // 追蹤同標題的歌曲（處理重複標題）
    const normalizedTitle = normalizeText(dbTitle)
    if (!songsByTitle[normalizedTitle]) {
      songsByTitle[normalizedTitle] = []
    }
    songsByTitle[normalizedTitle].push({
      songID,
      titleScore,
      artistScore,
      combinedScore,
      dbTitle,
      dbArtist
    })

    if (combinedScore > bestMatch.score) {
      bestMatch = {
        songID,
        score: combinedScore,
        titleScore,
        artistScore,
        confidence: combinedScore >= CONFIG.threshold ? "high" : "medium",
        dbTitle,
        dbArtist
      }
    }
  }

  // 處理重複標題的情況
  if (bestMatch.songID !== "*") {
    const normalizedBestTitle = normalizeText(bestMatch.dbTitle)
    const duplicates = songsByTitle[normalizedBestTitle]

    if (duplicates && duplicates.length > 1) {
      if (bestMatch.artistScore < 0.7) {
        bestMatch = {
          songID: "*",
          score: 0,
          confidence: "low",
          reason: "duplicate title, artist mismatch"
        }
      }
    }
  }

  return bestMatch
}

// ============================================================================
// Legacy findBestMatch (保留供參考，將被 findBestMatchWithIndex 取代)
// ============================================================================

function findBestMatch(parsedSong, songlistData, aliasesData) {
  let bestMatch = { songID: "*", score: 0, confidence: "low" }

  const songsByTitle = {}

  for (const [songID, songData] of Object.entries(songlistData)) {
    const [dbTitle, dbArtist] = songData.split('|').map(s => s?.trim() || '')

    const titleScore = calculateTitleScore(parsedSong, dbTitle, aliasesData)

    if (titleScore < 0.7) continue

    const artistScore = calculateArtistScore(parsedSong, dbArtist, aliasesData)

    const combinedScore = titleScore * CONFIG.titleWeight + artistScore * CONFIG.artistWeight

    const normalizedTitle = normalizeText(dbTitle)
    if (!songsByTitle[normalizedTitle]) {
      songsByTitle[normalizedTitle] = []
    }
    songsByTitle[normalizedTitle].push({
      songID,
      titleScore,
      artistScore,
      combinedScore,
      dbTitle,
      dbArtist
    })

    if (combinedScore > bestMatch.score) {
      bestMatch = {
        songID,
        score: combinedScore,
        titleScore,
        artistScore,
        confidence: combinedScore >= CONFIG.threshold ? "high" : "medium",
        dbTitle,
        dbArtist
      }
    }
  }

  if (bestMatch.songID !== "*") {
    const normalizedBestTitle = normalizeText(parsedSong.titleJP || parsedSong.titleEN)
    const duplicates = songsByTitle[normalizedBestTitle]

    if (duplicates && duplicates.length > 1) {
      if (bestMatch.artistScore < 0.7) {
        bestMatch = {
          songID: "*",
          score: 0,
          confidence: "low",
          reason: "duplicate title, artist mismatch"
        }
      }
    }
  }

  return bestMatch
}

// ============================================================================
// Main Matching Function
// ============================================================================

async function matchSetlist(setlistComment) {
  const startTime = Date.now()

  // Fetch data from Berry Site API
  const [aliasesData, songlistData] = await Promise.all([
    getAliasesData(),
    getSonglistData()
  ])

  const fetchTime = Date.now() - startTime
  const songCount = Object.keys(songlistData).length

  if (songCount === 0) {
    throw new Error(`Songlist is empty (fetchMs=${fetchTime})`)
  }

  // 建立搜索索引（一次建立，多次使用）
  const indexStartTime = Date.now()
  const searcher = buildSearchIndex(songlistData, aliasesData)
  const indexTime = Date.now() - indexStartTime

  const lines = setlistComment.split('\n')
  const songIDs = []
  const matches = []

  // 使用預建索引進行匹配
  const matchStartTime = Date.now()
  for (const line of lines) {
    const parsed = parseSetlistLine(line)

    if (!parsed) continue

    // 使用新的索引匹配函數
    const match = findBestMatchWithIndex(parsed, searcher, aliasesData)

    let finalSongID = "*"
    if (match.score >= CONFIG.threshold && match.songID !== "*") {
      finalSongID = match.songID
    }

    songIDs.push(finalSongID)
    matches.push({
      raw: parsed.raw,
      parsed,
      match,
      finalSongID
    })
  }
  const matchTime = Date.now() - matchStartTime

  return {
    success: true,
    songIDs,
    matches,
    debug: {
      songCount,
      totalLines: lines.length,
      parsedCount: matches.length,
      matchedCount: songIDs.filter(id => id !== "*").length,
      newCount: songIDs.filter(id => id === "*").length,
      processingTimeMs: Date.now() - startTime,
      timing: {
        fetchMs: fetchTime,
        indexBuildMs: indexTime,
        matchingMs: matchTime
      }
    }
  }
}

// ============================================================================
// Lambda Handler
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

export async function handler(event) {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: ''
    }
  }

  try {
    // Parse request body
    const body = typeof event.body === 'string'
      ? JSON.parse(event.body)
      : event.body

    const { setlistComment } = body

    if (!setlistComment) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Missing required field: setlistComment' }
        })
      }
    }

    // Execute matching
    const result = await matchSetlist(setlistComment)

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result)
    }

  } catch (error) {
    console.error('Lambda error:', error)
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message }
      })
    }
  }
}
