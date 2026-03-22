/**
 * @fileoverview Data fetching utilities for auto-update system
 */

import { extractVideoId } from '../utils/url-helpers.js'
import { getNewVideosFromChannels, getVideoInfo as ytGetVideoInfo } from '../utils/youtube-api.js'

/**
 * Data fetcher class for retrieving data from various sources
 */
export class DataFetcher {
  constructor(env, db) {
    this.retryCount = 3
    this.retryDelay = 1000 // milliseconds
    this.env = env
    this.db = db
  }

  /**
   * Fetch new videos from getytvideoinfo service
   * @returns {Promise<Array>} New videos
   */
  async fetchNewVideos() {
    try {
      const data = await getNewVideosFromChannels(this.env, this.db)

      if (!data.items || !Array.isArray(data.items)) {
        return []
      }

      // Filter for Berry's channel videos only
      const berryChannels = [
        'UC7A7bGRVdIwo93nqnA3x-OQ', // Main channel
        'UCBOGwPeBtaPRU59j8jshdjQ', // Sub channel 1
        'UC2cgr_UtYukapRUt404In-A'  // Sub channel 2
      ]

      const berryVideos = data.items.filter(video => {
        const channelId = video.snippet?.channelId
        return channelId && berryChannels.includes(channelId)
      })

      if (berryVideos.length > 0) {
        console.log(`[STREAM] 發現 ${berryVideos.length} 部新影片 (total: ${data.items.length})`)
      }

      return berryVideos

    } catch (error) {
      console.error(`[STREAM] 取得新影片失敗: ${error.message}`)
      throw new Error(`取得新影片失敗: ${error.message}`)
    }
  }

  /**
   * Get video info for a specific video ID
   * @param {string} videoId - YouTube video ID
   * @returns {Promise<Object>} Video info
   */
  async getVideoInfo(videoId) {
    try {
      const data = await ytGetVideoInfo(videoId, this.env)

      if (!data.items || data.items.length === 0) {
        throw new Error('影片未找到')
      }

      return data.items[0]

    } catch (error) {
      console.error(`[STREAM] 取得影片資訊失敗: ${videoId} - ${error.message}`)
      throw new Error(`取得影片資訊失敗： ${error.message}`)
    }
  }

  /**
   * Fetch with retry logic
   * @param {string} url - URL to fetch
   * @param {Object} options - Fetch options
   * @returns {Promise<Response>} Fetch response
   */
  async fetchWithRetry(url, options = {}) {
    let lastError

    for (let attempt = 1; attempt <= this.retryCount; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            'User-Agent': 'Berry-AutoUpdate/1.0',
            ...options.headers
          }
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        return response

      } catch (error) {
        lastError = error

        if (attempt < this.retryCount) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1)
          console.warn(`[RETRY] 第 ${attempt} 次失敗，${delay}ms 後重試: ${url}`)
          await this.sleep(delay)
        }
      }
    }

    throw new Error(`在 ${this.retryCount} 次嘗試後仍無法取得 ${url}: ${lastError.message}`)
  }

  /**
   * Sleep for specified milliseconds
   */
  sleep(ms) {
    return new Promise(resolve => {
      globalThis.setTimeout(() => resolve(), ms)
    })
  }

  /**
   * Validate video data structure
   */
  validateVideoData(video) {
    if (!video || typeof video !== 'object') {
      return false
    }

    const snippet = video.snippet
    if (!snippet) {
      return false
    }

    const requiredFields = ['videoId', 'title', 'publishedAt', 'channelId']

    for (const field of requiredFields) {
      if (!snippet[field]) {
        console.warn(`影片缺少必要欄位: ${field}`)
        return false
      }
    }

    return true
  }

  /**
   * Check if URL is a valid YouTube URL
   */
  isValidYouTubeUrl(url) {
    return extractVideoId(url) !== null
  }

  /**
   * Fetch pending streams (setlistComplete = false) from database
   * @param {string} mode - 'recent' (last 7 days) or 'all'
   * @returns {Promise<Array>} Pending streams
   */
  async fetchPendingStreams(mode = 'recent') {
    try {
      let sql = `SELECT streamID, title, time, categories, note
                 FROM streamlist
                 WHERE setlistComplete = false
                   AND JSON_SEARCH(categories, 'one', '%歌枠%') IS NOT NULL`

      if (mode === 'recent') {
        sql += ` AND time >= DATE_SUB(NOW(), INTERVAL 7 DAY)`
      }

      sql += ` ORDER BY time DESC`

      const pendingStreams = await this.db.query(sql)

      if (pendingStreams.length > 0) {
        console.log(`[STREAM] 發現 ${pendingStreams.length} 個待處理歌枠 (mode: ${mode})`)
      }

      // Format to worker format
      const formattedStreams = pendingStreams.map(stream => ({
        id: stream.streamID,
        title: stream.title,
        time: stream.time,
        category: stream.categories,
        note: stream.note
      }))

      return formattedStreams

    } catch (error) {
      console.error(`[STREAM] 取得待處理項目失敗: ${error.message}`)
      throw error
    }
  }
}
