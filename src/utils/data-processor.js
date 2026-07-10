/**
 * @fileoverview Data processing utilities for streamlist and setlist updates
 */

import { CONFIG } from '../config.js'
import { extractVideoId } from './url-helpers.js'
import { Database } from './database.js'
import { getVideoComments } from './youtube-comments.js'
import { getLiveDetails } from './youtube-api.js'
import { fuzzyMatchSetlist } from './fuzzy-matcher.js'
import { iso8601ToMySQL } from './middleware.js'
import { getSecret } from '../platform.js'

/**
 * Data processor class for updating streamlist and setlist data
 */
export class DataProcessor {
  constructor() {
    this.berryChannels = CONFIG.berryChannels
  }

  /**
   * Categorize stream based on title and channel (支援複選邏輯)
   * @param {string} title - Stream title
   * @param {string} channelId - Channel ID
   * @returns {Array<string>} Category array (supports multiple categories)
   */
  categorizeStream(title, channelId) {
    let categories = []
    let origin = ['xfd', 'オリジナル', 'music video']
    let chat = ['chat', 'talk', '雑談']
    let lowerTitle = title.toLowerCase()

    // 檢查子頻道（主頻道以外）
    const subChannels = this.berryChannels.slice(1)
    if (channelId && subChannels.includes(channelId)) {
      categories.push('Subchannel')
    }

    // 檢查內容類型（複選邏輯）
    if (lowerTitle.includes('gam')) {
      categories.push('ゲーム / Gaming')
    }
    if (lowerTitle.includes('short')) {
      categories.push('ショート / Shorts')
    }
    if (lowerTitle.includes('歌ってみた')) {
      categories.push('歌ってみた動画 / Cover movie')
    }
    if (origin.some(e => lowerTitle.includes(e))) {
      categories.push('オリジナル曲 / Original Songs')
    }
    if (chat.some(e => lowerTitle.includes(e))) {
      categories.push('雑談 / Chatting')
    }
    if (title.includes('歌枠')) {
      categories.push('歌枠 / Singing')
    }

    // 如果沒有任何內容類型分類，添加預設分類
    if (categories.length === 0 || (categories.length === 1 && categories[0] === 'Subchannel')) {
      categories.push('その他 / Others')
    }

    return categories
  }

  /**
   * 判斷解析時機狀態（2026-06 Gh6AsG8DmCI 事故防護）
   * @returns {'not-ended'|'cooldown'|'open'}
   *   not-ended: 直播未結束，不解析（runAutoUpdate 過去會在開播前反覆嘗試）
   *   cooldown : 結束後 cooldownHours 內，只認 preferredAuthor（歌單留言+API 索引延遲）
   *   open     : 完全開放三層
   */
  async resolveParseTiming(videoId, env, prefetched = null) {
    try {
      // polling 路徑已查過 live-details，直接沿用避免同輪重複呼叫 YouTube API
      const details = prefetched ?? await getLiveDetails(videoId, env)
      if (details) {
        const isUpload = !details.scheduledStartTime && !details.actualStartTime
        if (!isUpload) {
          if (!details.isEnded) return 'not-ended'
          const elapsed = Date.now() - new Date(details.actualEndTime).getTime()
          if (elapsed < CONFIG.commentFilter.cooldownHours * 3600_000) return 'cooldown'
        }
        // 上傳影片（非直播）無時序問題，直接開放
      }
    } catch (error) {
      // 查詢失敗（影片已刪等）不阻擋解析，照舊行為
      console.warn(`[SETLIST] live-details 查詢失敗，跳過時機檢查: ${videoId} - ${error.message}`)
    }
    return 'open'
  }

  /**
   * Parse setlist for a singing stream using Lambda fuzzy matching
   * @param {Object} stream - Stream object
   * @param {Object} env - Environment variables
   * @param {Object} options - { bypassCooldown: boolean } 手動 force 時跳過時機檢查
   * @returns {Promise<Array|null>} Array of individual song objects in flat format
   */
  async parseSetlistForStream(stream, env, { bypassCooldown = false, bypassGuards = false, liveDetails = null } = {}) {
    try {
      const streamUrl = `https://www.youtube.com/watch?v=${stream.id}`
      const videoId = extractVideoId(streamUrl)
      if (!videoId) {
        throw new Error('無效的 YouTube URL')
      }

      // 解析時機檢查
      let timing = 'open'
      if (!bypassCooldown) {
        timing = await this.resolveParseTiming(videoId, env, liveDetails)
        if (timing === 'not-ended') {
          console.log(`[SETLIST] 直播未結束，跳過解析: ${videoId}`)
          return null
        }
      }

      // Get comments and find setlist
      const apiKey = getSecret(env, 'YOUTUBE_API_KEY')
      const comments = await getVideoComments(videoId, apiKey)
      const commentResult = this.findSetlistComment(comments, { onlyPreferred: timing === 'cooldown' })

      if (!commentResult) {
        if (timing === 'cooldown') {
          console.log(`[SETLIST] cooldown 中（結束未滿 ${CONFIG.commentFilter.cooldownHours}h），等待 ${CONFIG.commentFilter.preferredAuthor} 歌單留言: ${videoId}`)
        }
        return null
      }
      console.log(`[SETLIST] 選中歌單留言: 層${commentResult.layer} by ${commentResult.author} (${videoId})`)

      const setlistComment = commentResult.text
      const commentAuthor = commentResult.author

      // Use Fuzzy Matching for setlist parsing（Lambda matcher 自行抓取 songlist/aliases）
      const result = await fuzzyMatchSetlist(setlistComment, env)

      if (!result || !result.songIDs || result.songIDs.length === 0) {
        return null
      }

      // 熔斷：過半行無法匹配（「*」）＝選錯留言（感想/雜訊），放棄整場避免垃圾入庫
      // （IVQA0vzQSkE 曾整場 18 首被建成垃圾初回）
      // 回傳 items:[] + blocked 標記：呼叫端據此發 Discord 警告（攔截不靜默，誤擋可及時發現）
      const { minLines, starRatio } = CONFIG.setlistCircuitBreak
      const starCount = result.songIDs.filter(id => id === '*').length
      if (!bypassGuards && result.songIDs.length >= minLines && starCount / result.songIDs.length > starRatio) {
        const reason = `熔斷: ${starCount}/${result.songIDs.length} 行無法匹配，疑似選錯留言`
        console.warn(`[SETLIST] ${reason}，放棄寫入 (${videoId}, 留言 by ${commentAuthor})`)
        return { items: [], blocked: { reason, commentAuthor } }
      }

      // Process songID array and handle "*" entries
      const setlistItems = []
      const skippedLines = []

      for (let i = 0; i < result.songIDs.length; i++) {
        const songID = result.songIDs[i]
        const matchInfo = result.matches[i]
        let finalSongID = songID
        let note = null
        let songName = null
        let artist = null

        // Handle "*" entries - create new songs
        if (songID === "*") {
          if (matchInfo && matchInfo.parsed) {
            const parsed = matchInfo.parsed

            // 建新曲（初回）必須帶時間戳：自動解析的真實初回 100% 帶戳（915 筆歷史驗證，
            // 無戳者僅手動補錄的不留檔場）；無戳＋無匹配＝感想/名言雜訊（6/15 名言事件最後防線）
            if (!bypassGuards && (parsed.startSec === null || parsed.startSec === undefined)) {
              console.warn(`[SONGLIST] 跳過無時間戳的未匹配行（疑似雜訊）: ${parsed.titleJP || parsed.titleEN}`)
              skippedLines.push(parsed.titleJP || parsed.titleEN || parsed.raw || '(空)')
              continue
            }

            songName = parsed.titleJP || parsed.titleEN || ''
            const songNameEn = parsed.titleEN || ''
            artist = parsed.artistJP || parsed.artistEN || ''
            const artistEn = parsed.artistEN || ''

            if (songName) {
              try {
                finalSongID = await this.createNewSong(songName, songNameEn, artist, artistEn, env)
                note = "初回(待確認)"
                console.log(`[SONGLIST] 初回歌曲新增: ${songName} / ${artist} (songID=${finalSongID})`)
              } catch (error) {
                console.error(`[SONGLIST] 初回歌曲新增失敗: ${songName} - ${error.message}`)
                throw error
              }
            } else {
              continue
            }
          } else {
            continue
          }
        }

        // Create setlist entry for database format
        setlistItems.push({
          streamID: videoId,
          trackNo: i + 1,
          segmentNo: 1,
          songID: finalSongID,
          note: note,
          songName: songName,
          artist: artist,
          startTime: matchInfo?.parsed?.startSec ?? null,
          endTime: matchInfo?.parsed?.endSec ?? null
        })
      }

      // 全部行被無戳防線跳過＝整條留言是雜訊（6/15 名言型），視同熔斷回報
      if (setlistItems.length === 0 && skippedLines.length > 0) {
        const reason = `全部 ${skippedLines.length} 行被無戳防線跳過（疑似感想/名言留言）`
        console.warn(`[SETLIST] ${reason} (${videoId}, 留言 by ${commentAuthor})`)
        return { items: [], blocked: { reason, commentAuthor, skippedLines } }
      }

      // Return setlist items + comment info for caller to handle notifications
      return { items: setlistItems, setlistComment, commentAuthor, skippedLines }

    } catch (error) {
      console.error(`[SETLIST] 解析歌單失敗: ${stream.title} - ${error.message}`)
      throw error
    }
  }

  /**
   * Find setlist comment from comments array（邏輯與 yt-setlist-discord 對齊）
   * 優先順序：
   *   1. preferredAuthor（@KL-gr1my）≥3 時間戳，多篇按時間戳合併（上下半場分篇）
   *   2. ≥5 時間戳 且 帶戳行佔比 ≥ tsLineRatio（排除「一行戳＋多行感想」的逐曲感想留言）
   *   3. 關鍵字 + ≥keywordMinTimestamps 時間戳（整份無戳一定不是歌單）
   * @param {Array} comments - Comments array
   * @param {{onlyPreferred?: boolean}} options - cooldown 期間只認層 1
   * @returns {{text: string, author: string, layer: number}|null}
   */
  findSetlistComment(comments, { onlyPreferred = false } = {}) {
    const { preferredAuthor, tsLineRatio, keywordMinTimestamps } = CONFIG.commentFilter
    const timestampRe = /\d{1,2}:\d{2}(?::\d{2})?/g

    const withMeta = comments.map(c => {
      const nonEmptyLines = c.text.split('\n').filter(l => l.trim())
      return {
        ...c,
        _ts: c.text.match(timestampRe) || [],
        _lineCount: nonEmptyLines.length || 1,
        _tsLineCount: nonEmptyLines.filter(l => /\d{1,2}:\d{2}/.test(l)).length,
      }
    })

    // 層1：preferredAuthor ≥3 時間戳（多篇合併）
    const klComments = withMeta.filter(c =>
      c.authorDisplayName === preferredAuthor && c._ts.length >= 3
    )
    if (klComments.length > 0) {
      return { ...this.mergeByTimestamp(klComments), layer: 1 }
    }

    // Cooldown 期間：歌單留言（通常結束後 15~60 分才發、API 索引再延遲 20~30 分）
    // 還沒就緒，層 2/3 撿到的多半是感想 → 留 pending 給下一輪
    if (onlyPreferred) return null

    // 層2：≥5 時間戳 + 帶戳行佔比（歌單留言幾乎每行有戳；逐曲感想佔比低）
    const timestampComments = withMeta
      .filter(c => c._ts.length >= 5 && c._tsLineCount / c._lineCount >= tsLineRatio)
      .sort((a, b) => b.likeCount - a.likeCount)

    if (timestampComments.length > 0) {
      const best = timestampComments[0]
      return { text: best.text, author: best.authorDisplayName || '匿名', layer: 2 }
    }

    // 層3：關鍵字 + 最低時間戳數
    const setlistKeywords = CONFIG.setlistKeywords
    const candidates = withMeta.filter(c => {
      if (c._ts.length < keywordMinTimestamps) return false
      const text = c.text.toLowerCase()
      return setlistKeywords.some(keyword => text.includes(keyword.toLowerCase())) &&
             (c._lineCount > CONFIG.commentFilter.minLines || text.length > CONFIG.commentFilter.minLength)
    })

    if (candidates.length === 0) {
      return null
    }

    candidates.sort((a, b) => {
      const scoreA = a.likeCount * CONFIG.commentFilter.likeWeight + a.text.length * CONFIG.commentFilter.lengthWeight
      const scoreB = b.likeCount * CONFIG.commentFilter.likeWeight + b.text.length * CONFIG.commentFilter.lengthWeight
      return scoreB - scoreA
    })

    return { text: candidates[0].text, author: candidates[0].authorDisplayName || '匿名', layer: 3 }
  }

  /**
   * 多篇歌單留言按首個時間戳排序合併（上下半場分兩篇發的情況）
   */
  mergeByTimestamp(comments) {
    const toSec = ts => {
      const p = ts.split(':').map(Number)
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]
    }
    const sorted = [...comments].sort((a, b) => toSec(a._ts[0]) - toSec(b._ts[0]))
    const authors = [...new Set(sorted.map(c => c.authorDisplayName || '匿名'))]
    return { text: sorted.map(c => c.text).join('\n\n'), author: authors.join(', ') }
  }


  /**
   * Create new song in songlist
   * @param {string} songName - Song name (Japanese)
   * @param {string} songNameEn - Song name (English)
   * @param {string} artist - Artist name (Japanese)
   * @param {string} artistEn - Artist name (English)
   * @param {Object} env - Environment variables
   * @returns {Promise<number>} New songID
   */
  async createNewSong(songName, songNameEn, artist, artistEn, env) {
    try {
      const db = new Database(env)
      const result = await db.execute(
        'INSERT INTO songlist (songName, songNameEn, artist, artistEn, songNote) VALUES (?, ?, ?, ?, ?)',
        [songName, songNameEn || null, artist, artistEn || null, '資訊待確認']
      )

      return result.meta.last_row_id

    } catch (error) {
      console.error(`[SONGLIST] 新增失敗: ${songName} - ${error.message}`)
      throw new Error(`新增歌曲失敗: ${error.message}`)
    }
  }

  /**
   * Batch create streamlist entries
   * @param {Array} streams - Stream items
   * @param {Object} env - Environment variables
   * @returns {Promise<Object>} API response
   */
  async batchCreateStreams(streams, env) {
    if (!streams || streams.length === 0) {
      return { success: true, insertedCount: 0 }
    }

    try {
      const db = new Database(env)
      let insertedCount = 0

      for (const stream of streams) {
        const streamID = stream.id
        const title = stream.snippet?.title || stream.title
        const time = stream.time
        const categories = stream.category ? [stream.category] : (stream.categories || [])
        const categoriesJson = JSON.stringify(categories)
        const note = stream.note || null

        // setlistComplete auto-tracking: singing streams start as false
        const isSinging = categories.some(cat => typeof cat === 'string' && cat.includes('歌枠'))
        const setlistComplete = isSinging ? false : true

        // INSERT IGNORE：PubSub 重複通知時靜默跳過已存在影片，避免 Duplicate ERROR log 噪音
        const result = await db.execute(
          'INSERT IGNORE INTO streamlist (streamID, title, time, categories, note, setlistComplete) VALUES (?, ?, ?, ?, ?, ?)',
          [streamID, title, iso8601ToMySQL(time), categoriesJson, note, setlistComplete]
        )
        if (result.meta.changes > 0) insertedCount++
      }

      return { success: true, insertedCount }

    } catch (error) {
      console.error(`[STREAM] 批次新增失敗: ${error.message}`)
      throw new Error(`批次新增 streamlist 失敗: ${error.message}`)
    }
  }

  /**
   * Update stream setlistComplete status
   * @param {string} streamID - Stream ID
   * @param {boolean} complete - Completion status
   * @param {Object} env - Environment variables
   * @returns {Promise<Object>} API response
   */
  async updateStreamSetlistComplete(streamID, complete, env) {
    try {
      const db = new Database(env)
      await db.execute(
        'UPDATE streamlist SET setlistComplete = ? WHERE streamID = ?',
        [complete, streamID]
      )

      return { success: true }

    } catch (error) {
      console.error(`[STREAM] setlistComplete 更新失敗: ${streamID} - ${error.message}`)
      throw new Error(`更新 setlistComplete 失敗: ${error.message}`)
    }
  }

  /**
   * Batch create setlist entries
   * @param {Array} entries - Setlist entries
   * @param {Object} env - Environment variables
   * @returns {Promise<Object>} API response
   */
  async batchCreateSetlist(entries, env) {
    try {
      const db = new Database(env)

      for (const entry of entries) {
        // UPSERT 保護既有資料：songID/note 既有值優先（人工修正不被自動解析覆寫）；
        // startTime/endTime 新值優先但 NULL 不覆寫（保住 endTime 回填成果）
        await db.execute(
          `INSERT INTO setlist_ori (streamID, trackNo, segmentNo, songID, note, startTime, endTime)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             songID = songID,
             note = COALESCE(note, VALUES(note)),
             startTime = COALESCE(VALUES(startTime), startTime),
             endTime = COALESCE(VALUES(endTime), endTime)`,
          [entry.streamID, entry.trackNo, entry.segmentNo || 1, entry.songID, entry.note || null,
           entry.startTime ?? null, entry.endTime ?? null]
        )
      }

      return { success: true, insertedCount: entries.length }

    } catch (error) {
      console.error(`[SETLIST] 批次新增失敗: ${error.message}`)
      throw new Error(`批次新增 setlist 失敗: ${error.message}`)
    }
  }
}
