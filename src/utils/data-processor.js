/**
 * @fileoverview Data processing utilities for streamlist and setlist updates
 */

import { CONFIG } from '../config.js'
import { extractVideoId } from './url-helpers.js'
import { Database } from './database.js'
import { getVideoComments as getVideoCommentsCore } from './youtube-comments.js'
import { fuzzyMatchSetlist } from './fuzzy-matcher.js'
import { iso8601ToMySQL } from './middleware.js'
import { getSecret } from '../platform.js'
// sendSetlistComment moved to callers (auto-update.js, app.js)

/**
 * Data processor class for updating streamlist and setlist data
 */
export class DataProcessor {
  constructor() {
    this.berryChannels = [
      'UC7A7bGRVdIwo93nqnA3x-OQ', // Berry's main channel
      'UCBOGwPeBtaPRU59j8jshdjQ', // Sub channel 1
      'UC2cgr_UtYukapRUt404In-A'  // Sub channel 2
    ]
  }

  /**
   * Get latest date from streamlist
   * @param {Array} streamlist - Streamlist data
   * @returns {string} Latest date string
   */
  getLatestStreamDate(streamlist) {
    if (!streamlist || streamlist.length === 0) {
      return '2020-01-01' // Default old date if empty
    }

    const dates = streamlist
      .map(item => item.time)
      .filter(date => date)
      .sort((a, b) => new Date(a) - new Date(b))

    return dates[dates.length - 1] || '2020-01-01'
  }

  /**
   * Get video publish date from video object
   * @param {Object} video - Video object from YouTube API
   * @returns {Date|null} Publish date
   */
  getVideoPublishDate(video) {
    const videoTime = video.time
    return videoTime ? new Date(videoTime) : null
  }

  /**
   * Convert video object to streamlist item format
   * @param {Object} video - Video object from YouTube API
   * @returns {Object|null} Streamlist item
   */
  convertVideoToStreamItem(video) {
    const snippet = video.snippet

    if (!snippet) {
      console.warn('[VIDEO] 影片缺少片段資料')
      return null
    }

    // Handle different video ID formats from different sources
    const videoId = video.id?.videoId || snippet.videoId || video.videoId || video.id
    const title = snippet.title
    const videoTime = video.time

    if (!videoId || !title || !videoTime) {
      console.warn(`[VIDEO] 影片缺少必要欄位: id=${videoId || 'missing'}, title=${title || 'missing'}`)
      return null
    }

    // Determine category based on title and channel
    const channelId = snippet.channelId
    const category = this.categorizeStream(title, channelId)

    // Format date
    const date = this.formatDate(videoTime)

    return {
      id: videoId,
      title: title,
      time: videoTime,
      category: category
    }
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

    // 檢查子頻道
    const subChannels = ['UCBOGwPeBtaPRU59j8jshdjQ', 'UC2cgr_UtYukapRUt404In-A']
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
   * Find singing streams that need setlist parsing
   * @param {Array} streamlist - Updated streamlist data
   * @param {Array} currentSetlist - Current setlist data
   * @param {string} mode - Comparison mode: 'recent', 'all'
   * @param {Object} options - Mode options: { days: number, youtubeId: string }
   * @returns {Array} Singing streams needing setlists
   */
  findSingingStreamsNeedingSetlists(streamlist, currentSetlist, mode = 'all', options = {}) {
    // Apply mode filtering to streamlist
    let filteredStreamlist = streamlist
    switch (mode) {
      case 'recent': {
        const days = CONFIG.comparisonModes.recent.days
        const cutoffDate = new Date()
        cutoffDate.setDate(cutoffDate.getDate() - days)
        const cutoffISOString = cutoffDate.toISOString().split('T')[0]

        filteredStreamlist = streamlist.filter(stream => {
          const streamDate = stream.time?.split('T')[0] || stream.time
          return streamDate >= cutoffISOString
        })
        break
      }

      case 'all':
      default:
        break
    }

    // Get existing setlist video IDs (handle flat structure)
    const existingSetlistIds = new Set(
      currentSetlist.map(item => {
        const videoId = extractVideoId(item.YTLink)
        return videoId
      }).filter(Boolean)
    )

    // Filter for singing streams without setlists
    const singingStreams = filteredStreamlist.filter((stream) => {
      // 檢查是否為歌唱直播（僅支援陣列格式，不向後相容字串）
      if (!Array.isArray(stream.category)) {
        throw new Error(`Invalid category format for stream ${stream.id}: expected array, got ${typeof stream.category}`)
      }

      const isSingingStream = stream.category.some(cat => cat.includes('歌枠'))

      if (!isSingingStream) {
        return false
      }

      // Check if setlist already exists (create URL from stream id)
      const streamUrl = `https://www.youtube.com/watch?v=${stream.id}`
      const videoId = extractVideoId(streamUrl)

      if (!videoId) {
        return false
      }

      if (existingSetlistIds.has(videoId)) {
        return false
      }

      return true
    })

    return singingStreams
  }

  /**
   * Parse setlist for a singing stream using Lambda fuzzy matching
   * @param {Object} stream - Stream object
   * @param {Object} env - Environment variables
   * @returns {Promise<Array|null>} Array of individual song objects in flat format
   */
  async parseSetlistForStream(stream, env) {
    try {
      const streamUrl = `https://www.youtube.com/watch?v=${stream.id}`
      const videoId = extractVideoId(streamUrl)
      if (!videoId) {
        throw new Error('無效的 YouTube URL')
      }

      // Get comments and find setlist
      const apiKey = getSecret(env, 'YOUTUBE_API_KEY') || getSecret(env, 'YOUTUBEAPIKEY')
      const comments = await this.getVideoComments(videoId, apiKey)
      const commentResult = this.findSetlistComment(comments)

      if (!commentResult) {
        return null
      }

      const setlistComment = commentResult.text
      const commentAuthor = commentResult.author

      // Parse the setlist comment to extract song-artist pairs
      const parsedSongs = this.parseSetlistComment(setlistComment)

      if (Object.keys(parsedSongs).length === 0) {
        return null
      }

      // Get songlist data for comparison
      const songlistData = await this.getSonglistData(env)

      // Use Fuzzy Matching for setlist parsing
      const result = await fuzzyMatchSetlist(setlistComment, songlistData, env)

      if (!result || !result.songIDs || result.songIDs.length === 0) {
        return null
      }

      // Process songID array and handle "*" entries
      const setlistItems = []

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

      // Return setlist items + comment info for caller to handle notifications
      return { items: setlistItems, setlistComment, commentAuthor }

    } catch (error) {
      console.error(`[SETLIST] 解析歌單失敗: ${stream.title} - ${error.message}`)
      throw error
    }
  }

  /**
   * Process setlist data and insert to database
   * @param {Array} newSetlistArrays - Array of setlist arrays from different streams (database format)
   * @param {Object} env - Environment variables
   * @returns {Promise<Object>} Insert result
   */
  async processAndInsertSetlists(newSetlistArrays, env) {
    // Flatten all new setlist entries into a single array
    const newEntries = newSetlistArrays.flat()

    if (newEntries.length === 0) {
      return { success: true, insertedCount: 0 }
    }

    try {
      const result = await this.batchCreateSetlist(newEntries, env)
      return {
        success: true,
        insertedCount: newEntries.length,
        result: result
      }

    } catch (error) {
      console.error(`[SETLIST] 歌單資料插入失敗: ${error.message}`)
      throw new Error(`歌單資料插入失敗: ${error.message}`)
    }
  }

  /**
   * Format date string to YYYY/MM/DD format
   * @param {string} isoString - ISO date string
   * @returns {string} Formatted date
   */
  formatDate(isoString) {
    const date = new Date(isoString)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}/${month}/${day}`
  }


  /**
   * Get video comments from YouTube API
   * @param {string} videoId - Video ID
   * @param {string} apiKey - YouTube API key
   * @returns {Promise<Array>} Comments
   */
  async getVideoComments(videoId, apiKey) {
    try {
      const comments = await getVideoCommentsCore(videoId, apiKey)
      return comments

    } catch (error) {
      console.error(`[YOUTUBE] 取得留言失敗: ${videoId} - ${error.message}`)
      throw new Error(`取得留言失敗: ${error.message}`)
    }
  }

  /**
   * Parse setlist comment to extract song-artist pairs
   * Based on fansite debug.html cleanSetlistComment function (lines 920-977)
   * @param {string} rawComment - Raw setlist comment text
   * @returns {Object} Parsed songs in {songName: artist} format
   */
  parseSetlistComment(rawComment) {
    if (!rawComment) return {};

    const lines = rawComment.split('\n');
    const cleanedSongs = {};

    lines.forEach(line => {
      // 跳過標題行
      if (line.includes('♬セトリ') || line.includes('Set List') ||
        line.includes('♬') || line.includes('setlist')) {
        return;
      }

      // 移除時間戳: 0:04:46 ~ 0:09:30
      line = line.replace(/\d+:\d+:\d+\s*~\s*\d+:\d+:\d+\s*/g, '');
      // 移除單一時間戳: 0:04:46 or 4:46
      line = line.replace(/\d{1,2}:\d{2}(?::\d{2})?\s*/g, '');

      // 移除序號: 01|, 1.|, 1.空格, ①等
      line = line.replace(/^[\d①②③④⑤⑥⑦⑧⑨⑩]+[\.|｜|\s]/g, '');

      // 移除英文/羅馬音括號內容
      line = line.replace(/\([^)]*\)/g, '');

      // 清理空白字元
      line = line.trim();

      // 如果行為空或太短，跳過
      if (!line || line.length < 3) return;

      // 過濾明確的噪音行（トーク、emoji分隔線、loading）
      const t = line.trim();
      if (/^(OP|ED|MC)?[  ]*トーク/i.test(t)) return;
      if (/^(オープニング|エンディング)/i.test(t)) return;
      if (/^(now\s*)?loading\.{0,3}$/i.test(t)) return;
      if (/^[\p{Emoji}\p{S}\s]+$/u.test(t) && t.length >= 3) return;

      // 尋找分隔符並拆分歌名和歌手
      let songName = '', artist = '';

      // 常見分隔符
      const separators = ['|', '｜', ' - ', '/', '  ', '\t'];

      for (const sep of separators) {
        if (line.includes(sep)) {
          const parts = line.split(sep, 2);
          songName = parts[0].trim();
          artist = parts[1] ? parts[1].trim() : '';
          break;
        }
      }

      // 如果找不到分隔符，整行作為歌名
      if (!songName) {
        songName = line.trim();
        artist = '';
      }

      // 只保留有歌名的項目
      if (songName && songName.length > 0) {
        cleanedSongs[songName] = artist;
      }
    });

    return cleanedSongs;
  }

  /**
   * Find setlist comment from comments array
   * 優先順序：1. @KL-gr1my 有時間戳的留言  2. 其他有 ≥5 個時間戳的留言  3. 關鍵字篩選
   * @param {Array} comments - Comments array
   * @returns {{text: string, author: string}|null} Setlist comment with author info
   */
  findSetlistComment(comments) {
    const PREFERRED_AUTHOR = '@KL-gr1my'
    const timestampRe = /\d{1,2}:\d{2}/g

    // 優先：@KL-gr1my 有時間戳的留言
    const klComments = comments.filter(c => c.authorDisplayName === PREFERRED_AUTHOR)
    for (const c of klComments) {
      const matches = c.text.match(timestampRe)
      if (matches && matches.length >= 3) {
        return { text: c.text, author: c.authorDisplayName || 'KL' }
      }
    }

    // 其次：任何有 ≥5 個時間戳的留言（按讚數排序）
    const timestampComments = comments
      .filter(c => {
        const matches = c.text.match(timestampRe)
        return matches && matches.length >= 5
      })
      .sort((a, b) => b.likeCount - a.likeCount)

    if (timestampComments.length > 0) {
      const best = timestampComments[0]
      return { text: best.text, author: best.authorDisplayName || '匿名' }
    }

    // 最後：關鍵字篩選（相容舊邏輯）
    const setlistKeywords = CONFIG.setlistKeywords
    const candidates = comments.filter(comment => {
      const text = comment.text.toLowerCase()
      return setlistKeywords.some(keyword => text.includes(keyword.toLowerCase())) &&
             (text.split('\n').length > CONFIG.commentFilter.minLines || text.length > CONFIG.commentFilter.minLength)
    })

    if (candidates.length === 0) {
      return null
    }

    candidates.sort((a, b) => {
      const scoreA = a.likeCount * CONFIG.commentFilter.likeWeight + a.text.length * CONFIG.commentFilter.lengthWeight
      const scoreB = b.likeCount * CONFIG.commentFilter.likeWeight + b.text.length * CONFIG.commentFilter.lengthWeight
      return scoreB - scoreA
    })

    return { text: candidates[0].text, author: candidates[0].authorDisplayName || '匿名' }
  }


  /**
   * Get songlist data for comparison from database
   * @param {Object} env - Environment variables
   * @returns {Promise<Object>} Optimized songlist data in {songID: "歌名|歌手"} format
   */
  async getSonglistData(env) {
    try {
      const db = new Database(env)
      const rows = await db.query(
        'SELECT songID, songName, songNameEn, artist, artistEn FROM songlist'
      )

      // Convert to optimized format: {songID: "歌名|歌手"}
      const songlistData = {}
      for (const row of rows) {
        const parts = [row.songName, row.artist]
        if (row.songNameEn) parts.push(row.songNameEn)
        if (row.artistEn) parts.push(row.artistEn)
        songlistData[row.songID] = parts.join('|')
      }

      return songlistData

    } catch (error) {
      console.error(`[SONGLIST] 載入失敗: ${error.message}`)
      throw new Error(`載入歌曲資料庫失敗: ${error.message}`)
    }
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

        try {
          await db.execute(
            'INSERT INTO streamlist (streamID, title, time, categories, note, setlistComplete) VALUES (?, ?, ?, ?, ?, ?)',
            [streamID, title, iso8601ToMySQL(time), categoriesJson, note, setlistComplete]
          )
          insertedCount++
        } catch (error) {
          // Duplicate entry - skip
          if (error.message.includes('Duplicate') || error.message.includes('1062')) {
            continue
          }
          throw error
        }
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
        // UPSERT: insert or update on duplicate
        await db.execute(
          `INSERT INTO setlist_ori (streamID, trackNo, segmentNo, songID, note, startTime, endTime)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE songID = VALUES(songID), note = VALUES(note),
             startTime = VALUES(startTime), endTime = VALUES(endTime)`,
          [entry.streamID, entry.trackNo, entry.segmentNo || 1, entry.songID, entry.note || null,
           entry.startTime || null, entry.endTime || null]
        )
      }

      return { success: true, insertedCount: entries.length }

    } catch (error) {
      console.error(`[SETLIST] 批次新增失敗: ${error.message}`)
      throw new Error(`批次新增 setlist 失敗: ${error.message}`)
    }
  }
}
