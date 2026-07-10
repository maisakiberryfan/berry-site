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
  const trimmed = text.trim()

  // 逐一抽出所有括號段，支援多段「日文(英文)」並列
  // 例：「熊田茜音(Kumada Akane) & 増井優花(Masui Yuka)」
  //  → jp:「熊田茜音 & 増井優花」 en:「Kumada Akane & Masui Yuka」
  // （舊版單一 regex 會把 en 切成「Kumada Akane) & 増井優花(Masui Yuka」）
  const parens = [...trimmed.matchAll(/\(([^()]*)\)/g)]
    .map(m => m[1].trim())
    .filter(Boolean)

  if (parens.length === 0) {
    if (/^[A-Za-z0-9 '\-!?.,&×]+$/.test(trimmed)) {
      return { jp: trimmed, en: trimmed }
    }
    return { jp: trimmed, en: '' }
  }

  const jp = trimmed.replace(/\s*\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const en = parens.length === 1 ? parens[0] : parens.join(' & ')
  return { jp, en }
}

// Split on "slash followed by whitespace" like /\s*\/\s+/, but only at
// parenthesis depth 0 so reading-guide parens are never cut in half.
function splitSlashOutsideParens(s) {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === '/' && depth === 0 && /\s/.test(s[i + 1] || '')) {
      return [s.slice(0, i).trimEnd(), s.slice(i + 1).trim()]
    }
  }
  return [s]
}

function timeToSeconds(str) {
  const parts = str.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return null
}

function isNoiseLine(text) {
  const t = text.trim()
  // Talk/MC/opening/ending segments
  if (/^(OP|ED|MC)?[  ]*トーク/i.test(t)) return true
  if (/^(OP|ED|MC)$/i.test(t)) return true
  if (/^(オープニング|エンディング)/i.test(t)) return true
  // Loading markers
  if (/^(now\s*)?loading\.{0,3}$/i.test(t)) return true
  // Emoji-only lines
  if (/^[\p{Emoji}\p{S}\s]+$/u.test(t) && t.length >= 3) return true
  // 慶祝/里程碑插行（帶時間戳混在歌單中，如「45K subscribers! おめでとう！」）；
  // 限無歌手分隔的行，避免誤傷歌名
  if (!t.includes('|') && /おめでとう|congrat|subscribers?|登録者/i.test(t)) return true
  return false
}

function parseSetlistLine(line) {
  if (!line || line.length < 3) return null

  // 全形括號/斜線正規化（「宇野ゆう子（Yuko Uno）」曾因全形（）沒被切分而整串建成新歌手）
  let cleaned = line.replace(/（/g, '(').replace(/）/g, ')').replace(/／/g, '/')

  if (cleaned.includes('♬セトリ') || cleaned.includes('Set List') ||
      cleaned.includes('setlist') || cleaned.match(/^♬/)) {
    return null
  }

  // 提取時間戳（先提取再去除）
  let startSec = null, endSec = null
  const rangeRe = /(\d{1,2}:\d{2}(?::\d{2})?)\s*[~～–\-]\s*(\d{1,2}:\d{2}(?::\d{2})?)/
  const singleRe = /(\d{1,2}:\d{2}(?::\d{2})?)/

  const rangeMatch = cleaned.match(rangeRe)
  if (rangeMatch) {
    startSec = timeToSeconds(rangeMatch[1])
    endSec = timeToSeconds(rangeMatch[2])
    cleaned = cleaned.replace(rangeRe, '')
  } else {
    const singleMatch = cleaned.match(singleRe)
    if (singleMatch) {
      startSec = timeToSeconds(singleMatch[1])
      cleaned = cleaned.replace(singleRe, '')
    }
  }

  cleaned = cleaned.trim()
  cleaned = cleaned.replace(/^[\d①②③④⑤⑥⑦⑧⑨⑩]+[.|｜|\s]/g, '')
  cleaned = cleaned.trim()

  // 有時間戳的行是強歌單訊號，允許 1-2 字歌名（夜空、炎、糸…）；
  // 無時間戳行維持 ≥3 防雜訊
  const minLen = startSec !== null ? 1 : 3
  if (!cleaned || cleaned.length < minLen) return null

  // 去戳去序後整行只剩「(xxx)」＝時刻註記而非曲名（「25:04 (big dream)」曾被建成垃圾新曲）；
  // 真實曲名不會整個包在括號裡
  if (/^\([^()]*\)$/.test(cleaned)) return null

  // Filter noise lines (talk segments, emoji dividers, loading, 感言)
  if (isNoiseLine(cleaned)) return null

  let songPart = ''
  let artistPart = ''

  // 主分隔的斜線要求兩側空格（「曲名 / 歌手」格式）：裸 '/' 會把「ハロ/ハワユ」等
  // 含斜線曲名、或括號內含斜線的無 | 行從斜線處切爆（split 限 2 段還會丟棄餘文）；
  // 不匹配時整行交給下游 splitSlashOutsideParens（括號感知）處理
  const separators = ['|', '｜', ' - ', ' / ', '  ', '\t']

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

  // 「歌名 / 羅馬字 | 歌手」三段格式：主分隔（|）切完後 song 段內殘留的
  // 「日文 / 非日文」是日英對照而非歌手，需在此切開（否則整串比對必失敗）。
  // 斜線前可無空格（「ウィーアー！/ We Are!」）、後必有空格（保護「1/6」等歌名）；
  // 切分點必須在括號外 ——「ハロ/ハワユ(Hello/ how are you)」的斜線+空格在
  // 括號內，曾被從括號中間切開（jp=「ハロ/ハワユ(Hello」）導致整行判成新曲；
  // 右側判定用「不含假名/漢字」而非純 ASCII（羅馬字常含 ☆ 等符號）
  let song
  const hasJa = s => /[぀-ヿ一-鿿]/.test(s)
  const slashSplit = splitSlashOutsideParens(songPart)
  if (slashSplit.length === 2) {
    const [jpSide, enSide] = slashSplit.map(s => s.trim())
    if (jpSide && enSide && hasJa(jpSide) && !hasJa(enSide)) {
      song = { jp: jpSide, en: enSide }
    }
  }
  if (!song) song = extractJpEn(songPart)
  const artist = extractJpEn(artistPart)

  return {
    titleJP: song.jp,
    titleEN: song.en,
    artistJP: artist.jp,
    artistEN: artist.en,
    raw: line,
    startSec,
    endSec
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

/**
 * 抽出歌名尾部的「序號」（續作編號）：II/Ⅱ(NFKC→ii)/2/弐 等
 * 序號是強區別訊號 —— 「おじゃま虫2」與「おじゃま虫」是不同曲，
 * 但 leven 距離只差 1 字元，fuzzy 比對會誤判成同曲
 */
const SEQ_MAP = {
  ii: '2', iii: '3', iv: '4',
  '二': '2', '三': '3', '四': '4', '五': '5',
  '弐': '2', '参': '3',
}
function extractTrailingSeq(normalized) {
  const m = normalized.match(/^(.*?)[\s\-~・]*((?:ii|iii|iv)|[0-9]+|[二三四五弐参])$/)
  // 整個名稱就是數字（如曲名「39」）不視為序號
  if (!m || !m[1].trim()) return { base: normalized, seq: null }
  return { base: m[1].trim(), seq: SEQ_MAP[m[2]] ?? m[2] }
}

/**
 * 帶序號感知的歌名相似度：
 * - 序號不同（或一有一無）→ 打折，避免續作曲誤判到本傳
 * - 序號相同 → 改比 base 部分（「おじゃま虫2」vs「おじゃま虫Ⅱ」的 base 完全一致 → 1.0，
 *   不因序號寫法差異（2/II/Ⅱ）被 leven 距離拉低）
 */
function titleSimilarity(str1, str2) {
  const a = extractTrailingSeq(normalizeText(str1))
  const b = extractTrailingSeq(normalizeText(str2))

  if (a.seq !== b.seq) return calculateSimilarity(str1, str2) * 0.6
  if (a.seq !== null) return calculateSimilarity(a.base, b.base)
  return calculateSimilarity(str1, str2)
}

function calculateArtistScore(parsedSong, dbArtist, dbArtistEn, aliasesData) {
  if (!dbArtist && !dbArtistEn) return 0

  const inputVariations = [
    ...expandAliases(parsedSong.artistJP, aliasesData.artistAliases || {}),
    ...expandAliases(parsedSong.artistEN, aliasesData.artistAliases || {})
  ].filter(Boolean)

  const dbVariations = [
    ...expandAliases(dbArtist, aliasesData.artistAliases || {}),
    ...(dbArtistEn ? [normalizeText(dbArtistEn)] : [])
  ]

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

function calculateTitleScore(parsedSong, dbTitle, dbTitleEn, aliasesData, songID) {
  if (!dbTitle && !dbTitleEn) return 0

  const inputVariations = [
    ...expandAliases(parsedSong.titleJP, aliasesData.titleAliases || {}),
    ...expandAliases(parsedSong.titleEN, aliasesData.titleAliases || {})
  ].filter(Boolean)

  // 綁定 songID 的 alias 只屬於這首歌（preprocessAliases 已將其自字串表移除）
  const idAliases = (songID != null && aliasesData.titleAliasesByID?.[songID]) || []
  const dbVariations = [
    ...expandAliases(dbTitle, aliasesData.titleAliases || {}),
    ...(dbTitleEn ? [normalizeText(dbTitleEn)] : []),
    ...idAliases.map(a => normalizeText(a))
  ]

  if (inputVariations.length === 0) return 0

  let maxScore = 0
  for (const inputVar of inputVariations) {
    for (const dbVar of dbVariations) {
      const score = titleSimilarity(inputVar, dbVar)
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
    // 固定 4 段格式「歌名|歌手|英文歌名|英文歌手」（舊 API 只給 2 段時 En 為空）
    const [dbTitle, dbArtist, dbTitleEn, dbArtistEn] = songData.split('|').map(s => s?.trim() || '')
    const base = { songID, dbTitle, dbArtist, dbTitleEn, dbArtistEn }

    // 加入原始標題
    entries.push({ ...base, searchKey: normalizeText(dbTitle) })

    // 英文歌名也進索引（「英文歌名行」直接命中，不再依賴日文名相似度）
    if (dbTitleEn && normalizeText(dbTitleEn) !== normalizeText(dbTitle)) {
      entries.push({ ...base, searchKey: normalizeText(dbTitleEn) })
    }

    // 標題 aliases：優先用 songID 綁定的精準對應（同名異曲不互染），
    // 字串 key 的舊表作為未綁定 alias 的 fallback
    const idAliases = aliasesData.titleAliasesByID?.[songID] || []
    const strAliases = (aliasesData.titleAliases?.[dbTitle] || []).filter(a => !idAliases.includes(a))
    for (const alias of [...idAliases, ...strAliases]) {
      entries.push({ ...base, searchKey: normalizeText(alias) })
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
      const { songID, dbTitle, dbArtist, dbTitleEn, dbArtistEn } = result.item
      const searchScore = result.score

      // 保留每首歌的最高搜索分數
      if (!candidateMap.has(songID) || candidateMap.get(songID).searchScore < searchScore) {
        candidateMap.set(songID, { songID, dbTitle, dbArtist, dbTitleEn, dbArtistEn, searchScore })
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
    const { songID, dbTitle, dbArtist, dbTitleEn, dbArtistEn } = candidate

    // 精細計算 title score
    const titleScore = calculateTitleScore(parsedSong, dbTitle, dbTitleEn, aliasesData, songID)
    if (titleScore < 0.7) continue

    // 計算 artist score
    const artistScore = calculateArtistScore(parsedSong, dbArtist, dbArtistEn, aliasesData)

    // 無歌手輸入時 artist 必為 0、combined 上限 0.75 永遠過不了 threshold（歷史層2/3
    // 留言常見「時間 歌名」無歌手格式，整份全進「*」）。改用純 titleScore 但門檻
    // 提高到 0.95 —— 同名異曲仍由下方 duplicate-title dedup（artist<0.7 打回）保護
    const hasArtistInput = !!(parsedSong.artistJP || parsedSong.artistEN)
    const combinedScore = hasArtistInput
      ? titleScore * CONFIG.titleWeight + artistScore * CONFIG.artistWeight
      : (titleScore >= 0.95 ? titleScore : titleScore * CONFIG.titleWeight)

    // 輸入歌名與 DB 歌名（日/英）「直接完全一致」者加微小 bonus 作 tie-break：
    // alias 展開或包含關係可能讓相近曲名（おじゃま虫 vs おじゃま虫Ⅱ）同拿滿分，
    // 此時應優先選字面一致的那首，而非先被迭代到的 songID
    const inJP = parsedSong.titleJP && normalizeText(parsedSong.titleJP)
    const inEN = parsedSong.titleEN && normalizeText(parsedSong.titleEN)
    const dbT = normalizeText(dbTitle)
    const dbTEn = dbTitleEn && normalizeText(dbTitleEn)
    const directExact =
      (inJP && (inJP === dbT || inJP === dbTEn)) ||
      (inEN && (inEN === dbT || inEN === dbTEn))
    const adjustedScore = combinedScore + (directExact ? 0.01 : 0)

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

    if (adjustedScore > bestMatch.score) {
      bestMatch = {
        songID,
        score: adjustedScore,
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
// Main Matching Function
// ============================================================================

/**
 * 預處理 aliases：已綁定 songID 的 alias（titleAliasesByID）從字串表移除。
 * 字串表以 canonicalName（歌名）為 key，同名異曲會共享 alias 造成互染
 * （「おじゃま虫Ⅱ」曾被掛在「おじゃま虫」字串 key 下，導致Ⅱ永遠判到無印）；
 * 綁定 songID 後 alias 只屬於那一首。
 */
function preprocessAliases(aliasesData) {
  const byID = aliasesData.titleAliasesByID || {}
  const bound = new Set(Object.values(byID).flat().map(a => normalizeText(a)))
  if (bound.size === 0) return aliasesData

  const titleAliases = {}
  for (const [key, list] of Object.entries(aliasesData.titleAliases || {})) {
    const filtered = list.filter(a => !bound.has(normalizeText(a)))
    if (filtered.length) titleAliases[key] = filtered
  }
  return { ...aliasesData, titleAliases }
}

async function matchSetlist(setlistComment) {
  const startTime = Date.now()

  // Fetch data from Berry Site API
  const [rawAliasesData, songlistData] = await Promise.all([
    getAliasesData(),
    getSonglistData()
  ])
  const aliasesData = preprocessAliases(rawAliasesData)

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

  // 先解析全部行
  const parsedLines = lines.map(parseSetlistLine).filter(Boolean)

  // 歌單必有時間戳：當多數行帶時間戳時，無時間戳的行（末尾感想、補充文字）視為雜訊。
  // 例：KL 留言尾的「新衣装かわいいね」曾被建成「初回(待確認)」垃圾歌
  const timestamped = parsedLines.filter(p => p.startSec !== null)
  const effectiveLines = timestamped.length >= 3 ? timestamped : parsedLines

  // 使用預建索引進行匹配
  const matchStartTime = Date.now()
  for (const parsed of effectiveLines) {
    // 使用新的索引匹配函數
    let match = findBestMatchWithIndex(parsed, searcher, aliasesData)

    // 「歌名 / Romaji」格式：斜線後其實是歌名的羅馬字/英譯而非歌手，
    // 會因 artist 比對失敗被打低分。低分時改以「無歌手＋該段當英文歌名」重試，
    // 取較高分者（正常「歌名 / 歌手」行第一輪即達標，不受影響）
    if (match.score < CONFIG.threshold && (parsed.artistJP || parsed.artistEN)) {
      const alt = {
        ...parsed,
        titleEN: parsed.titleEN || parsed.artistEN || parsed.artistJP,
        artistJP: '',
        artistEN: ''
      }
      const retry = findBestMatchWithIndex(alt, searcher, aliasesData)
      if (retry.score > match.score) match = retry
    }

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
