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
  // 輸入護欄：matchSetlist() 逐行 fuzzy 比對無上限，超大輸入會讓比對階段隨行數線性放大。
  // 實測最長場次 raw 231 行（NNZErosM_zg，115 首），500 留足量體不誤傷正常歌單。
  maxLines: 500,
  // 行數之外還要管字元數：leven 是 O(n·m)，單行長度對耗時是二次方成長 ——
  // 500 行 × 每行 200 字（~100KB）就能把 29s 預算吃光，光算行數擋不住。
  // 實測最長歌單留言約 10KB／最長行 120 字，1000 字／200KB 留足餘裕。
  maxLineChars: 1000,
  maxTotalChars: 200_000,
  // 上游（本站 API）抓取：單次 8s timeout，失敗退避重試一次
  fetchTimeoutMs: 8000,
  fetchRetryDelayMs: 300,
  // 內部軟時限：Lambda timeout 29s（API Gateway 上限）到點會讓 APIGW 吐 504、
  // 呼叫端可能進重試迴圈。20s 先自己收手回 400，帶已處理行數供追查
  softDeadlineMs: 20_000,
}

/** 超過內部軟時限：handler 轉 400（而非讓 APIGW 504） */
class SoftTimeoutError extends Error {
  constructor(processedLines, totalLines, elapsedMs) {
    super(`Soft time limit exceeded after ${processedLines}/${totalLines} lines (${elapsedMs}ms)`)
    this.name = 'SoftTimeoutError'
    this.processedLines = processedLines
    this.totalLines = totalLines
    this.elapsedMs = elapsedMs
  }
}

// ============================================================================
// Data Fetching from Berry Site API
// ============================================================================

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 抓上游 JSON：8s timeout（無 timeout 時 Lambda 會被上游拖到 29s 才死），
 * 失敗（含 timeout / 5xx / 網路）退避後重試一次
 */
async function fetchJsonWithRetry(url, label) {
  let lastError
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(CONFIG.fetchTimeoutMs) })
      if (!response.ok) {
        throw new Error(`${label} API error: ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt === 2) break
      console.warn(`[MATCHER] ${label} 抓取失敗（第 ${attempt} 次）: ${error.message}，${CONFIG.fetchRetryDelayMs}ms 後重試`)
      await sleep(CONFIG.fetchRetryDelayMs)
    }
  }
  throw lastError
}

/**
 * Fetch aliases data from Berry Site API
 */
async function getAliasesData() {
  const result = await fetchJsonWithRetry(`${BERRY_SITE_API_URL}/api/aliases/grouped`, 'Aliases')

  if (!result.success) {
    throw new Error(result.error?.message || 'Aliases API returned error')
  }

  return result.data
}

/**
 * Fetch songlist data from Berry Site API (optimized format)
 */
async function getSonglistData() {
  const result = await fetchJsonWithRetry(`${BERRY_SITE_API_URL}/api/songlist/optimized`, 'Songlist')

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

// 時間戳值域上限＝100 小時（與主站 PUT /api/setlist 的 0~360000 驗證同值）
const MAX_TIME_SECONDS = 360000

/**
 * 「h:mm:ss」「mm:ss」→ 秒。值域不合（分/秒 ≥60、超過 100 小時、非有限數）一律回 null，
 * 讓下游視為「無時間戳」而不是把 3600*99 這種垃圾值寫進 DB
 */
function timeToSeconds(str) {
  const parts = String(str).split(':')
  if (parts.length !== 2 && parts.length !== 3) return null
  if (!parts.every(p => /^\d{1,3}$/.test(p))) return null

  const nums = parts.map(Number)
  if (!nums.every(Number.isFinite)) return null

  // 末段＝秒、h:mm:ss 的中段＝分，皆須 <60（mm:ss 的分段可 >59，如 90:00＝90 分）
  if (nums[nums.length - 1] >= 60) return null
  if (nums.length === 3 && nums[1] >= 60) return null

  const seconds = nums.length === 3
    ? nums[0] * 3600 + nums[1] * 60 + nums[2]
    : nums[0] * 60 + nums[1]

  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TIME_SECONDS) return null
  return seconds
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
  // 豎線近似字一併轉半形 '|'：留言常出現 │ ￨ ǀ ∣ ┃ ¦ 等視覺上等同分隔線的字元，
  // 不轉的話整行「曲名│歌手」不切分、被當成一整條新曲名
  let cleaned = line.replace(/（/g, '(').replace(/）/g, ')').replace(/／/g, '/')
    .replace(/[│￨ǀ∣┃¦]/g, '|')

  if (cleaned.includes('♬セトリ') || cleaned.includes('Set List') ||
      cleaned.includes('setlist') || cleaned.match(/^♬/)) {
    return null
  }

  // 提取時間戳（先提取再去除）
  let startSec = null, endSec = null
  const rangeRe = /(\d{1,2}:\d{2}(?::\d{2})?)\s*[~～–\-]\s*(\d{1,2}:\d{2}(?::\d{2})?)/
  // 前後補邊界：無邊界時「123:45」會被吃成「23:45」（多算 20 分鐘），
  // 「12:345」也會被吃成「12:34」；兩者都不是合法時間戳，寧可判無戳
  const singleRe = /(?<![\d:])(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])/

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

  // endSec 只有在「晚於 startSec」時才有意義：等於或早於＝解析錯（跨頁換行、打錯），
  // 丟棄比寫進 DB 好（UPSERT 的 COALESCE 會把錯值當有效值保留）。
  // startSec 無效時 endSec 也一併丟（單有結束時間無從對應）
  if (startSec === null || (endSec !== null && endSec <= startSec)) endSec = null

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

// 子串命中（includes）的最小長度：1~2 字的別名（「炎」「ff」…）出現在任何長曲名裡
// 都算命中，會把整組別名灌進變體、造成跨曲互染。完全相等不受此限
const MIN_ALIAS_SUBSTRING_LEN = 3
const aliasHit = (normalized, candidate) =>
  normalized === candidate || (candidate.length >= MIN_ALIAS_SUBSTRING_LEN && normalized.includes(candidate))

/**
 * 裸斜線切分（fallback 專用）：把「曲名/歌手」型（斜線兩側無空格）拆成曲名＋歌手。
 * titleJP/titleEN 是 extractJpEn 產物、括號已被移除，故可直接用第一個 '/' 切。
 * 切不出兩段有內容的結果就回 null（呼叫端維持原判定）
 */
function splitOnBareSlash(parsed) {
  const source = parsed.titleJP || parsed.titleEN || ''
  const idx = source.indexOf('/')
  if (idx <= 0 || idx >= source.length - 1) return null

  const left = source.slice(0, idx).trim()
  const right = source.slice(idx + 1).trim()
  if (!left || !right) return null

  const title = extractJpEn(left)
  const artist = extractJpEn(right)
  return {
    ...parsed,
    titleJP: title.jp,
    titleEN: title.en,
    artistJP: artist.jp,
    artistEN: artist.en
  }
}

function expandAliases(text, aliasMap) {
  if (!text) return []

  const normalized = normalizeText(text)
  const variations = [normalized]

  for (const [key, aliases] of Object.entries(aliasMap)) {
    const normalizedKey = normalizeText(key)

    if (aliasHit(normalized, normalizedKey)) {
      variations.push(normalizedKey)
      aliases.forEach(alias => variations.push(normalizeText(alias)))
    } else {
      for (const alias of aliases) {
        const normalizedAlias = normalizeText(alias)
        if (aliasHit(normalized, normalizedAlias)) {
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
const ROMAN_SEQ_RE = /^(?:iii|iv|ii)$/
function extractTrailingSeq(normalized) {
  // 分隔符量詞收斂為 {0,3} 並先 trimEnd：原本 `[\s\-~・]*` 搭配 lazy 前綴，
  // 對長字串會在每個切點反覆回溯（無序號時尤甚）
  const trimmed = normalized.trimEnd()
  const m = trimmed.match(/^(.*?)([\s\-~・]{0,3})((?:iii|iv|ii)|[0-9]+|[二三四五弐参])$/)
  // 整個名稱就是數字（如曲名「39」）不視為序號
  if (!m || !m[1].trim()) return { base: normalized, seq: null }
  // 「kawaii」「umai」型：羅馬數字緊貼拉丁字母＝單字尾巴，不是序號
  // （kawaii 曾被拆成 base「kawa」+ seq 2）
  if (ROMAN_SEQ_RE.test(m[3]) && !m[2] && /[a-z]$/i.test(m[1])) {
    return { base: normalized, seq: null }
  }
  return { base: m[1].trim(), seq: SEQ_MAP[m[3]] ?? m[3] }
}

// 序號比較數值化：'2' 與 '02'（或 SEQ_MAP 轉出的 '2'）是同一個序號，字串比會判成不同
function seqValue(seq) {
  if (seq === null || seq === undefined) return null
  const n = Number(seq)
  return Number.isFinite(n) ? n : seq
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
  const seqA = seqValue(a.seq)
  const seqB = seqValue(b.seq)

  if (seqA !== seqB) return calculateSimilarity(str1, str2) * 0.6
  if (seqA !== null) return calculateSimilarity(a.base, b.base)
  return calculateSimilarity(str1, str2)
}

function calculateArtistScore(parsedSong, dbArtist, dbArtistEn, aliasesData) {
  if (!dbArtist && !dbArtistEn) return 0

  // 變體皆為 normalize 後字串，去重不改變 max 結果、省掉重複的 leven 計算
  const inputVariations = [...new Set([
    ...expandAliases(parsedSong.artistJP, aliasesData.artistAliases || {}),
    ...expandAliases(parsedSong.artistEN, aliasesData.artistAliases || {})
  ].filter(Boolean))]

  const dbVariations = [...new Set([
    ...expandAliases(dbArtist, aliasesData.artistAliases || {}),
    ...(dbArtistEn ? [normalizeText(dbArtistEn)] : [])
  ])]

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

  const inputVariations = [...new Set([
    ...expandAliases(parsedSong.titleJP, aliasesData.titleAliases || {}),
    ...expandAliases(parsedSong.titleEN, aliasesData.titleAliases || {})
  ].filter(Boolean))]

  // 綁定 songID 的 alias 只屬於這首歌（preprocessAliases 已將其自字串表移除）
  const idAliases = (songID != null && aliasesData.titleAliasesByID?.[songID]) || []
  const dbVariations = [...new Set([
    ...expandAliases(dbTitle, aliasesData.titleAliases || {}),
    ...(dbTitleEn ? [normalizeText(dbTitleEn)] : []),
    ...idAliases.map(a => normalizeText(a))
  ])]

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
 * @param {Map<string, Array>|null} searchCache 每請求共用的 searcher.search 記憶化
 *   （同一份歌單裡「同一個變體字串」會被反覆搜尋——各行的 alias 展開高度重疊，
 *   retry 路徑更是拿幾乎相同的變體再搜一輪）
 */
function findBestMatchWithIndex(parsedSong, searcher, aliasesData, searchCache = null) {
  // 取得輸入的標題變體（包含 aliases）
  // 去重以 normalizeText 為 key，但**傳給 search 的是原字串**（保守做法：
  // fast-fuzzy 自帶正規化，先自行 normalize 再送可能改變其內部評分）
  const rawVariations = [
    parsedSong.titleJP,
    parsedSong.titleEN,
    ...expandAliases(parsedSong.titleJP, aliasesData.titleAliases || {}),
    ...expandAliases(parsedSong.titleEN, aliasesData.titleAliases || {})
  ].filter(Boolean)

  const seenVariations = new Map()  // normalize 後字串 -> 首次出現的原字串
  for (const raw of rawVariations) {
    const key = normalizeText(raw)
    if (!seenVariations.has(key)) seenVariations.set(key, raw)
  }
  const inputVariations = [...seenVariations.entries()]  // [normalizedKey, rawString]

  if (inputVariations.length === 0) {
    return { songID: "*", score: 0, confidence: "low" }
  }

  // 用所有變體搜索，合併候選
  const candidateMap = new Map()  // songID -> best candidate info

  for (const [cacheKey, inputTitle] of inputVariations) {
    let results
    if (searchCache && searchCache.has(cacheKey)) {
      results = searchCache.get(cacheKey)
    } else {
      results = searcher.search(inputTitle)
      if (searchCache) searchCache.set(cacheKey, results)
    }

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
  // 排序（tie-break）用 adjustedScore，門檻與回傳分數用 combinedScore ——
  // 兩者混用會讓 directExact 的候選實際門檻降成 0.87 並吐出 score=1.01
  let bestAdjustedScore = 0
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
    // 此時應優先選字面一致的那首，而非先被迭代到的 songID。
    // ⚠️ bonus 只用於候選之間排序，不參與門檻比較、不進回傳 score
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

    if (adjustedScore > bestAdjustedScore) {
      bestAdjustedScore = adjustedScore
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

const emptyAliases = () => ({ titleAliases: {}, artistAliases: {}, titleAliasesByID: {} })

async function matchSetlist(setlistComment, { startedAt = Date.now() } = {}) {
  const startTime = Date.now()

  // Fetch data from Berry Site API
  // aliases 只是加分項（別名展開），單獨掛掉時以空別名表降級續跑比整場失敗好；
  // songlist 是比對的本體，掛掉就沒得比 —— 只有它算致命
  const [aliasesResult, songlistResult] = await Promise.allSettled([
    getAliasesData(),
    getSonglistData()
  ])

  if (songlistResult.status === 'rejected') {
    throw songlistResult.reason
  }
  const songlistData = songlistResult.value

  let aliasesDegraded = false
  let rawAliasesData = emptyAliases()
  if (aliasesResult.status === 'fulfilled' && aliasesResult.value) {
    rawAliasesData = aliasesResult.value
  } else {
    aliasesDegraded = true
    console.warn(`[MATCHER] aliases 抓取失敗，以空別名表降級續跑: ${aliasesResult.reason?.message || 'no data'}`)
  }
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
  // searcher.search 記憶化：整份留言（含 retry 路徑）共用一份，key＝normalize 後的變體字串
  const searchCache = new Map()
  let processedLines = 0
  for (const parsed of effectiveLines) {
    // 內部軟時限：到點自己收手（回 400），不讓 API Gateway 吐 504 進重試迴圈
    const elapsed = Date.now() - startedAt
    if (elapsed > CONFIG.softDeadlineMs) {
      throw new SoftTimeoutError(processedLines, effectiveLines.length, elapsed)
    }
    processedLines++

    // 使用新的索引匹配函數
    let match = findBestMatchWithIndex(parsed, searcher, aliasesData, searchCache)

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
      const retry = findBestMatchWithIndex(alt, searcher, aliasesData, searchCache)
      if (retry.score > match.score) match = retry
    }

    // 裸斜線 fallback：無歌手且第一輪落空的行，可能是「曲名/歌手」沒空格
    // （主分隔的 ' / ' 要求兩側空格以保護「ハロ/ハワユ」等含斜線曲名）。
    // 僅落空時才切一次——第一輪即命中的含斜線曲名完全不受影響
    let bareSlashSplit = false
    if (match.score < CONFIG.threshold && !parsed.artistJP && !parsed.artistEN) {
      const alt = splitOnBareSlash(parsed)
      if (alt) {
        bareSlashSplit = true
        const retry = findBestMatchWithIndex(alt, searcher, aliasesData, searchCache)
        if (retry.score > match.score) match = retry
      }
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
      finalSongID,
      // 曾以裸斜線切分過、切完仍未命中：曲名裡多半黏著歌手（「オレンジ/とらドラ！」），
      // 直接建新曲會產出髒名字。data-processor 見此標記即拒建（index 與 songIDs 對齊）
      ...(finalSongID === '*' && bareSlashSplit ? { fallbackSplit: true } : {})
    })
  }
  const matchTime = Date.now() - matchStartTime

  return {
    success: true,
    songIDs,
    matches,
    debug: {
      songCount,
      ...(aliasesDegraded ? { aliasesDegraded: true } : {}),
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

  const startedAt = Date.now()

  const badRequest = (message, code = 'VALIDATION_ERROR') => ({
    statusCode: 400,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: false, error: { code, message } })
  })

  try {
    // Parse request body
    let body
    if (typeof event.body === 'string') {
      try {
        body = JSON.parse(event.body)
      } catch {
        return badRequest('Invalid JSON body')
      }
    } else {
      body = event.body
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest('Request body must be a JSON object')
    }

    const { setlistComment } = body

    if (typeof setlistComment !== 'string') {
      return badRequest('Field setlistComment must be a string')
    }

    if (!setlistComment) {
      return badRequest('Missing required field: setlistComment')
    }

    // 輸入護欄（字元數）：leven 對單行長度是二次方成長，光算行數擋不住 ——
    // 超限直接拒絕（截斷會把一行砍成半句、比對結果反而更難追查）
    if (setlistComment.length > CONFIG.maxTotalChars) {
      console.warn(`[MATCHER] setlistComment 總長 ${setlistComment.length} 超過上限 ${CONFIG.maxTotalChars}，拒絕處理`)
      return badRequest(`setlistComment exceeds ${CONFIG.maxTotalChars} characters`, 'INPUT_TOO_LARGE')
    }

    const allLines = setlistComment.split('\n')
    const longLineIndex = allLines.findIndex(line => line.length > CONFIG.maxLineChars)
    if (longLineIndex !== -1) {
      console.warn(`[MATCHER] setlistComment 第 ${longLineIndex + 1} 行長度 ${allLines[longLineIndex].length} 超過上限 ${CONFIG.maxLineChars}，拒絕處理`)
      return badRequest(`Line ${longLineIndex + 1} exceeds ${CONFIG.maxLineChars} characters`, 'INPUT_TOO_LARGE')
    }

    // 輸入護欄：行數超限則截斷（不靜默丟棄，留 log 供追查異常來源）
    let effectiveComment = setlistComment
    if (allLines.length > CONFIG.maxLines) {
      console.warn(`[MATCHER] setlistComment 行數 ${allLines.length} 超過上限 ${CONFIG.maxLines}，截斷處理`)
      effectiveComment = allLines.slice(0, CONFIG.maxLines).join('\n')
    }

    // Execute matching
    const result = await matchSetlist(effectiveComment, { startedAt })

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result)
    }

  } catch (error) {
    console.error('Lambda error:', error)

    // 軟時限：回 400（而非讓 APIGW 到 29s 吐 504 觸發上游重試），帶已處理行數供追查
    if (error instanceof SoftTimeoutError) {
      return badRequest(
        `Processing time limit reached after ${error.processedLines}/${error.totalLines} lines`,
        'PROCESSING_TIMEOUT'
      )
    }

    // 錯誤細節只進 console（error.message 可能夾帶上游 URL／回應內容）
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
      })
    }
  }
}
