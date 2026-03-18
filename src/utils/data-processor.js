/**
 * @fileoverview Data processing utilities for streamlist and setlist updates
 */

import { CONFIG } from '../config.js'
import { extractVideoId } from './url-helpers.js'
import { getLogger } from './unified-logger.js'
import { Database } from './database.js'
import { getVideoComments as getVideoCommentsCore } from './youtube-comments.js'
import { fuzzyMatchSetlist } from './fuzzy-matcher.js'
import { iso8601ToMySQL } from './middleware.js'
import { getSecret } from '../platform.js'

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
    const logger = getLogger()

    if (!streamlist || streamlist.length === 0) {
      return '2020-01-01' // Default old date if empty
    }

    const dates = streamlist
      .map(item => item.time)
      .filter(date => date)
      // 🧪 TEST MODE: 增強日誌 - 修復前的字符串排序
      // .sort() // ❌ 字符串排序會導致日期比較錯誤
      .sort((a, b) => new Date(a) - new Date(b)) // ✅ 正確的日期排序

    const latestDate = dates[dates.length - 1] || '2020-01-01'

    logger.info('STREAM', '📅 最新直播日期', { 最新日期: latestDate, 總日期數: dates.length })

    return latestDate
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
      const logger = getLogger()
      logger.warn('VIDEO', '⚠️ 影片缺少片段資料', { 影片資料: video })
      return null
    }
    
    // Handle different video ID formats from different sources
    const videoId = video.id?.videoId || snippet.videoId || video.videoId || video.id
    const title = snippet.title
    const videoTime = video.time
    
    if (!videoId || !title || !videoTime) {
      const logger = getLogger()
      logger.warn('VIDEO', '⚠️ 影片缺少必要欄位', {
        videoId: videoId || 'missing',
        title: title || 'missing',
        videoTime: videoTime || 'missing'
      })
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
    const logger = getLogger()

    logger.info('SETLIST', '🎵 開始尋找需要解析歌單的歌唱直播', {
      歌單項目數: currentSetlist?.length || 0,
      直播項目數: streamlist?.length || 0,
      比對模式: mode,
      模式選項: options
    })

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

        logger.info('SETLIST', `📅 最近${days}天模式`, {
          篩選日期基準: cutoffISOString,
          原始數量: streamlist.length,
          篩選後數量: filteredStreamlist.length
        })
        break
      }

      case 'all':
      default:
        logger.info('SETLIST', '🔄 全部比對模式', { 處理數量: streamlist.length })
        break
    }

    // Get existing setlist video IDs (handle flat structure)
    const existingSetlistIds = new Set(
      currentSetlist.map(item => {
        const videoId = extractVideoId(item.YTLink)
        return videoId
      }).filter(Boolean)
    )

    logger.info('SETLIST', '🎵 歌單篩選基準', {
      既有歌單數量: currentSetlist.length,
      既有影片ID數: existingSetlistIds.size
    })

    // 🧪 TEST MODE: 詳細的歌唱直播築選過程
    const filterStats = {
      非歌唱直播: 0,
      已有歌單: 0,
      無效ID: 0,
      處理範例: []
    }

    // Filter for singing streams without setlists
    const singingStreams = filteredStreamlist.filter((stream, index) => {
      // 檢查是否為歌唱直播（僅支援陣列格式，不向後相容字串）
      if (!Array.isArray(stream.category)) {
        throw new Error(`Invalid category format for stream ${stream.id}: expected array, got ${typeof stream.category}`)
      }

      const isSingingStream = stream.category.some(cat => cat.includes('歌枠'))

      if (!isSingingStream) {
        filterStats.非歌唱直播++
        if (filterStats.處理範例.length < 3) {
          filterStats.處理範例.push(`${stream.title}:非歌唱直播`)
        }
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
    
    logger.info('SETLIST', '🔍 歌唱直播篩選結果', filterStats)
    return singingStreams
  }

  /**
   * Parse setlist for a singing stream using Lambda fuzzy matching
   * @param {Object} stream - Stream object
   * @param {Object} env - Environment variables
   * @returns {Promise<Array|null>} Array of individual song objects in flat format
   */
  async parseSetlistForStream(stream, env) {
    const logger = getLogger()

    try {
      logger.info('SETLIST', `🤖 開始解析歌單: ${stream.title}`, { 影片ID: stream.id })

      const streamUrl = `https://www.youtube.com/watch?v=${stream.id}`
      const videoId = extractVideoId(streamUrl)
      if (!videoId) {
        throw new Error('無效的 YouTube URL')
      }

      // Get comments and find setlist
      const apiKey = getSecret(env, 'YOUTUBE_API_KEY') || getSecret(env, 'YOUTUBEAPIKEY')
      const comments = await this.getVideoComments(videoId, apiKey)
      const setlistComment = this.findSetlistComment(comments)

      if (!setlistComment) {
        logger.info('SETLIST', `ℹ️ 未發現歌單留言: ${stream.title}`, { 影片ID: stream.id })
        return null
      }

      // Parse the setlist comment to extract song-artist pairs
      const parsedSongs = this.parseSetlistComment(setlistComment)

      if (Object.keys(parsedSongs).length === 0) {
        logger.info('SETLIST', `ℹ️ 留言解析無結果: ${stream.title}`, { 影片ID: stream.id })
        return null
      }

      logger.info('SETLIST', `📝 解析留言完成`, { 歌曲數: Object.keys(parsedSongs).length })

      // Get songlist data for comparison
      const songlistData = await this.getSonglistData(env)

      // Use Fuzzy Matching for setlist parsing
      logger.info('SETLIST', '🔍 使用 Fuzzy Matching 進行歌單比對')
      const result = await fuzzyMatchSetlist(setlistComment, songlistData, env)

      if (!result || !result.songIDs || result.songIDs.length === 0) {
        logger.info('SETLIST', `ℹ️ 未解析到歌曲: ${stream.title}`, {
          影片ID: stream.id,
          標題: stream.title,
          匹配結果: result
        })
        return null
      }

      // Log fuzzy matching debug info
      logger.info('SETLIST', '✅ Fuzzy Matching 完成', {
        總曲數: result.debug.parsedCount,
        命中數: result.debug.matchedCount,
        初回數: result.debug.newCount
      })

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
            // Extract all 4 fields (JP and EN versions)
            songName = parsed.titleJP || parsed.titleEN || ''
            const songNameEn = parsed.titleEN || ''
            artist = parsed.artistJP || parsed.artistEN || ''
            const artistEn = parsed.artistEN || ''

            if (songName) {
              try {
                finalSongID = await this.createNewSong(songName, songNameEn, artist, artistEn, env)
                note = "初回(待確認)"

                logger.info('SONGLIST', '✅ 初回歌曲新增完成', {
                  歌名: songName,
                  歌名En: songNameEn,
                  歌手: artist,
                  歌手En: artistEn,
                  新songID: finalSongID
                })
              } catch (error) {
                logger.error('SONGLIST', `❌ 初回歌曲新增失敗: ${songName}`, { err: { message: error.message } })
                throw error
              }
            } else {
              logger.warn('SONGLIST', '⚠️ 無效的歌曲資料', { 匹配索引: i })
              continue
            }
          } else {
            logger.warn('SONGLIST', '⚠️ songID 索引超出匹配範圍', { 索引: i })
            continue
          }
        }

        // Create setlist entry for database format
        // 初回歌曲包含 songName/artist 供 Discord 通知使用
        setlistItems.push({
          streamID: videoId,
          trackNo: i + 1,
          segmentNo: 1,
          songID: finalSongID,
          note: note,
          songName: songName,
          artist: artist
        })
      }

      logger.info('SETLIST', '✅ setlist 項目建立完成', {
        總項目數: setlistItems.length,
        初回歌曲數: setlistItems.filter(item => item.note === "初回(待確認)").length,
        已知歌曲數: setlistItems.filter(item => !item.note).length
      })

      // Return setlist items for database insertion
      logger.info('SETLIST', `✅ 成功解析 ${result.songIDs.length} 首歌曲: ${stream.title}`, {
        影片ID: stream.id,
        歌曲數量: result.songIDs.length,
        setlist項目數: setlistItems.length
      })
      return setlistItems

    } catch (error) {
      logger.error('SETLIST', `❌ 解析歌單失敗: ${stream.title}`, {
        影片ID: stream.id,
        err: { message: error.message, stack: error.stack }
      })
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
    const logger = getLogger()

    // Flatten all new setlist entries into a single array
    const newEntries = newSetlistArrays.flat()

    if (newEntries.length === 0) {
      logger.info('SETLIST', 'ℹ️ 無新歌單項目需要插入')
      return { success: true, insertedCount: 0 }
    }

    logger.info('SETLIST', '🎵 開始處理和插入歌單資料', {
      新歌單群組數: newSetlistArrays.length,
      總項目數: newEntries.length
    })

    try {
      // Batch insert all setlist entries to database
      const result = await this.batchCreateSetlist(newEntries, env)

      logger.info('SETLIST', '✅ 歌單資料插入完成', {
        插入項目數: newEntries.length,
        項目範例: newEntries.slice(0, 3)
      })

      return {
        success: true,
        insertedCount: newEntries.length,
        result: result
      }

    } catch (error) {
      logger.error('SETLIST', '❌ 歌單資料插入失敗', {
        項目數: newEntries.length,
        err: { message: error.message, stack: error.stack }
      })
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
   * Get video comments from YouTube API (wrapper with debug logging)
   * @param {string} videoId - Video ID
   * @param {string} apiKey - YouTube API key
   * @returns {Promise<Array>} Comments
   */
  async getVideoComments(videoId, apiKey) {
    const logger = getLogger()
    try {
      logger.info('YOUTUBE', `📝 開始取得影片留言: ${videoId}`)

      // Use unified getVideoComments function
      const comments = await getVideoCommentsCore(videoId, apiKey)

      logger.info('YOUTUBE', `✅ 取得留言完成: ${comments.length} 則`, {
        留言數量: comments.length
      })
      return comments

    } catch (error) {
      logger.error('YOUTUBE', '❌ 取得留言失敗', {
        影片ID: videoId,
        err: { message: error.message, stack: error.stack }
      })
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

      // 移除序號: 01|, 1.|, 1.空格, ①等
      line = line.replace(/^[\d①②③④⑤⑥⑦⑧⑨⑩]+[\.|｜|\s]/g, '');

      // 移除英文/羅馬音括號內容
      line = line.replace(/\([^)]*\)/g, '');

      // 清理空白字元
      line = line.trim();

      // 如果行為空或太短，跳過
      if (!line || line.length < 3) return;

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
   * @param {Array} comments - Comments array
   * @returns {string|null} Setlist comment
   */
  findSetlistComment(comments) {
    const logger = getLogger()

    logger.info('SETLIST', '🔍 開始搜尋歌單留言', { 留言總數: comments.length })

    // Use keywords from config
    const setlistKeywords = CONFIG.setlistKeywords

    // Find comments that contain setlist indicators
    const candidates = comments.filter(comment => {
      const text = comment.text.toLowerCase()
      return setlistKeywords.some(keyword => text.includes(keyword.toLowerCase())) &&
             (text.split('\n').length > CONFIG.commentFilter.minLines || text.length > CONFIG.commentFilter.minLength)
    })

    if (candidates.length === 0) {
      logger.info('SETLIST', '❌ 未發現歌單候選留言', {
        檢查總數: comments.length,
        關鍵字: CONFIG.setlistKeywords
      })
      return null
    }

    // Sort by like count and length, prefer longer comments with more likes
    candidates.sort((a, b) => {
      const scoreA = a.likeCount * CONFIG.commentFilter.likeWeight + a.text.length * CONFIG.commentFilter.lengthWeight
      const scoreB = b.likeCount * CONFIG.commentFilter.likeWeight + b.text.length * CONFIG.commentFilter.lengthWeight
      return scoreB - scoreA
    })

    logger.info('SETLIST', '✅ 發現歌單留言', {
      候選數量: candidates.length,
      選中留言按讚數: candidates[0].likeCount,
      選中留言長度: candidates[0].text.length,
      留言預覽: candidates[0].text.substring(0, 100)
    })
    return candidates[0].text
  }


  /**
   * Get songlist data for comparison from Hyperdrive API
   * @param {Object} env - Environment variables
   * @returns {Promise<Object>} Optimized songlist data in {songID: "歌名|歌手"} format
   */
  async getSonglistData(env) {
    const logger = getLogger()

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

      logger?.info('SONGLIST', `載入 ${Object.keys(songlistData).length} 首歌曲`)
      return songlistData

    } catch (error) {
      logger?.error('SONGLIST', `載入失敗: ${error.message}`, {
        err: { message: error.message }
      })
      throw new Error(`載入歌曲資料庫失敗: ${error.message}`)
    }
  }

  /**
   * Create new song in songlist via Hyperdrive API
   * @param {string} songName - Song name (Japanese)
   * @param {string} songNameEn - Song name (English)
   * @param {string} artist - Artist name (Japanese)
   * @param {string} artistEn - Artist name (English)
   * @param {Object} env - Environment variables
   * @returns {Promise<number>} New songID
   */
  async createNewSong(songName, songNameEn, artist, artistEn, env) {
    const logger = getLogger()

    try {
      logger?.info('SONGLIST', `新增歌曲: ${songName}`, { songNameEn, artist, artistEn })

      const db = new Database(env)
      const result = await db.execute(
        'INSERT INTO songlist (songName, songNameEn, artist, artistEn, songNote) VALUES (?, ?, ?, ?, ?)',
        [songName, songNameEn || null, artist, artistEn || null, '資訊待確認']
      )

      const newSongID = result.meta.last_row_id
      logger?.info('SONGLIST', `新增成功 songID=${newSongID}`, { songName, artist })
      return newSongID

    } catch (error) {
      logger?.error('SONGLIST', `新增失敗: ${songName}`, {
        err: { message: error.message }
      })
      throw new Error(`新增歌曲失敗: ${error.message}`)
    }
  }

  /**
   * Batch create streamlist entries via Hyperdrive API
   * @param {Array} streams - Stream items
   * @param {Object} env - Environment variables
   * @returns {Promise<Object>} API response
   */
  async batchCreateStreams(streams, env) {
    const logger = getLogger()

    if (!streams || streams.length === 0) {
      logger?.info('STREAM', '無新直播項目需要插入')
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
            logger?.info('STREAM', `已存在，跳過: ${streamID}`)
            continue
          }
          throw error
        }
      }

      logger?.info('STREAM', `批次新增成功: ${insertedCount} 項`)
      return { success: true, insertedCount }

    } catch (error) {
      logger?.error('STREAM', `批次新增失敗: ${error.message}`, {
        count: streams.length,
        err: { message: error.message }
      })
      throw new Error(`批次新增 streamlist 失敗: ${error.message}`)
    }
  }

  /**
   * Update stream setlistComplete status via Hyperdrive API
   * @param {string} streamID - Stream ID
   * @param {boolean} complete - Completion status
   * @param {Object} env - Environment variables
   * @returns {Promise<Object>} API response
   */
  async updateStreamSetlistComplete(streamID, complete, env) {
    const logger = getLogger()

    try {
      const db = new Database(env)
      await db.execute(
        'UPDATE streamlist SET setlistComplete = ? WHERE streamID = ?',
        [complete, streamID]
      )

      logger?.info('STREAM', `setlistComplete 更新成功: ${streamID}`, {
        streamID,
        setlistComplete: complete
      })

      return { success: true }

    } catch (error) {
      logger?.error('STREAM', `setlistComplete 更新失敗: ${streamID}`, {
        streamID,
        setlistComplete: complete,
        err: { message: error.message }
      })
      throw new Error(`更新 setlistComplete 失敗: ${error.message}`)
    }
  }

  /**
   * Batch create setlist entries via Hyperdrive API
   * @param {Array} entries - Setlist entries
   * @param {Object} env - Environment variables
   * @returns {Promise<Object>} API response
   */
  async batchCreateSetlist(entries, env) {
    const logger = getLogger()

    try {
      const db = new Database(env)

      for (const entry of entries) {
        // UPSERT: insert or update on duplicate
        await db.execute(
          `INSERT INTO setlist_ori (streamID, trackNo, segmentNo, songID, note)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE songID = VALUES(songID), note = VALUES(note)`,
          [entry.streamID, entry.trackNo, entry.segmentNo || 1, entry.songID, entry.note || null]
        )
      }

      logger?.info('SETLIST', `批次新增成功`, {
        count: entries.length
      })

      return { success: true, insertedCount: entries.length }

    } catch (error) {
      logger?.error('SETLIST', `批次新增失敗`, {
        count: entries.length,
        err: { message: error.message }
      })
      throw new Error(`批次新增 setlist 失敗: ${error.message}`)
    }
  }
}