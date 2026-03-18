/**
 * @fileoverview Auto-update logic for streamlist and setlist (v2 - Database driven)
 * 使用統一日誌系統
 */

import { DataFetcher } from './data-fetcher.js'
import { DataProcessor } from '../utils/data-processor.js'
import { extractVideoId } from '../utils/url-helpers.js'
import { initLogger, getLogger } from '../utils/unified-logger.js'
import { sendDiscordNotification } from '../utils/discord-notifier.js'
import { getLiveDetails } from '../utils/youtube-api.js'
import { Database } from '../utils/database.js'
import { getSecret } from '../platform.js'
import { iso8601ToMySQL } from '../utils/middleware.js'

/**
 * Main auto-update function
 * @param {Object} env - Environment variables
 * @param {string} mode - Comparison mode: 'recent', 'all'
 * @param {Object} options - Mode options: { days: number }
 * @param {string} triggerType - Type of trigger: 'CRON', 'MANUAL'
 * @returns {Promise<Object>} Update result
 */
export async function runAutoUpdate(env, mode = 'recent', options = {}, triggerType = 'CRON') {
  const startTime = Date.now()

  // 初始化 logger（如果尚未初始化）
  let logger = getLogger()
  if (!logger) {
    logger = initLogger(env)
  }
  logger.startRequest()

  logger.info('CRON', `開始自動更新`, { mode, trigger: triggerType })

  // 在每日 Cron 時嘗試續訂 PubSubHubbub（每 4 天一次）
  if (triggerType === 'CRON') {
    try {
      await renewPubSubSubscription(env)
    } catch (subError) {
      logger.warn('PUBSUB', '訂閱續訂檢查失敗（非致命）', { err: { message: subError.message } })
    }
  }

  // Initialize clients
  const db = new Database(env)
  const dataFetcher = new DataFetcher(env, db)
  const dataProcessor = new DataProcessor()

  const result = {
    timestamp: new Date().toISOString(),
    streamlistUpdated: false,
    setlistUpdated: false,
    newStreams: 0,
    newSetlists: 0,
    errors: [],
    executionTime: 0,
    streamlistItems: [],
    setlistItems: [],
    failedItems: [],
    debutSongs: []
  }

  try {
    // Step 1: Get new videos
    let newVideos = []
    const pubsubVideoId = options.pubsubVideoId

    if (pubsubVideoId) {
      // PubSub 模式：直接用 videoId 查詢單一影片
      logger.info('STREAM', `PubSub 直接查詢: ${pubsubVideoId}`)
      try {
        let video = await dataFetcher.getVideoInfo(pubsubVideoId)
        if (video) {
          const channelId = video.snippet?.channelId
          const title = video.snippet?.title || ''
          // 驗證是否為目標頻道
          if (dataProcessor.berryChannels.includes(channelId)) {
            video.categories = dataProcessor.categorizeStream(title, channelId)

            // 若為直播項目且無法取得 scheduledStartTime，等待後重試
            // Lambda 環境跳過 2 分鐘等待（會超時），改由 Polling 安全網修正
            const broadcastStatus = video.snippet?.liveBroadcastContent
            const hasScheduledTime = !!video.liveStreamingDetails?.scheduledStartTime
            const isLambda = typeof process !== 'undefined' && !globalThis.caches
            if ((broadcastStatus === 'upcoming' || broadcastStatus === 'live') && !hasScheduledTime) {
              if (isLambda) {
                logger.info('STREAM', `Lambda 環境：跳過 2 分鐘等待，交由 Polling 安全網修正`, {
                  videoId: pubsubVideoId,
                  liveBroadcastContent: broadcastStatus
                })
              } else {
                logger.info('STREAM', `直播項目缺少 scheduledStartTime，2 分鐘後重試`, {
                  videoId: pubsubVideoId,
                  liveBroadcastContent: broadcastStatus,
                  currentTime: video.time
                })
                await new Promise(resolve => setTimeout(resolve, 120_000))
                try {
                  const retryVideo = await dataFetcher.getVideoInfo(pubsubVideoId)
                  if (retryVideo?.liveStreamingDetails?.scheduledStartTime) {
                    video = { ...retryVideo, categories: video.categories }
                    logger.info('STREAM', `重試成功，取得 scheduledStartTime`, {
                      videoId: pubsubVideoId,
                      scheduledStartTime: retryVideo.liveStreamingDetails.scheduledStartTime
                    })
                  } else {
                    logger.warn('STREAM', `重試仍無法取得 scheduledStartTime，使用 publishedAt`, {
                      videoId: pubsubVideoId,
                      fallbackTime: video.time
                    })
                  }
                } catch (retryError) {
                  logger.warn('STREAM', `重試查詢失敗: ${retryError.message}`, { videoId: pubsubVideoId })
                }
              }
            }

            newVideos = [video]
          } else {
            logger.info('STREAM', `非目標頻道，跳過: ${channelId}`)
          }
        }
      } catch (error) {
        logger.warn('STREAM', `PubSub 影片查詢失敗: ${error.message}，改用 /newvideos`)
        newVideos = await dataFetcher.fetchNewVideos()
      }
    } else {
      // Cron 模式：查詢所有新影片
      newVideos = await dataFetcher.fetchNewVideos()
    }

    if (!newVideos || newVideos.length === 0) {
      logger.info('STREAM', '無新影片，繼續檢查待處理項目')
    } else {
      logger.info('STREAM', `發現 ${newVideos.length} 部新影片`)
    }

    // Step 2: Write new streams to Hyperdrive database
    if (newVideos && newVideos.length > 0) {
      try {
        const writeResult = await dataProcessor.batchCreateStreams(newVideos, env)

        if (writeResult.insertedCount > 0) {
          result.streamlistUpdated = true
          result.newStreams = writeResult.insertedCount
          result.streamlistItems = newVideos.map(item => ({
            videoId: item.id,
            date: formatDateForDisplay(item.time),
            title: item.snippet?.title || item.title
          }))
        }

        logger.info('STREAM', `寫入結果: ${writeResult.insertedCount} 新增 / ${newVideos.length} 總計`)
      } catch (error) {
        logger.error('STREAM', `寫入失敗: ${error.message}`, {
          err: { message: error.message }
        })
        result.errors.push(`Streamlist 寫入失敗: ${error.message}`)
      }
    }

    // Step 3: Query pending streams from database
    const singingStreams = await dataFetcher.fetchPendingStreams(mode)

    if (singingStreams.length === 0) {
      logger.info('SETLIST', '沒有歌枠需要解析')
    } else {
      logger.info('SETLIST', `發現 ${singingStreams.length} 個待解析歌枠`)

      // Step 4: Parse setlists for singing streams using Lambda fuzzy matching
      const setlistResults = []

      for (const stream of singingStreams) {
        try {
          logger.info('SETLIST', `開始解析: ${stream.title}`, { videoId: stream.id })

          const setlistResult = await dataProcessor.parseSetlistForStream(stream, env)

          if (setlistResult && setlistResult.length > 0) {
            setlistResults.push(setlistResult)
            result.setlistItems.push({
              videoId: stream.id,
              date: formatDateForDisplay(stream.time),
              title: stream.title,
              songCount: setlistResult.length
            })

            // 解析成功後標記為完成
            try {
              await dataProcessor.updateStreamSetlistComplete(stream.id, true, env)
            } catch (updateError) {
              logger.warn('SETLIST', `更新 setlistComplete 失敗: ${stream.id}`, { err: { message: updateError.message } })
            }

            logger.info('SETLIST', `解析成功: ${setlistResult.length} 首歌`, {
              videoId: stream.id,
              songs: setlistResult.length
            })
          } else {
            result.failedItems.push({
              videoId: stream.id,
              date: formatDateForDisplay(stream.time),
              title: stream.title,
              reason: '未找到歌單留言'
            })
          }
        } catch (error) {
          logger.error('SETLIST', `解析失敗: ${stream.title}`, {
            videoId: stream.id,
            err: { message: error.message }
          })
          result.errors.push(`歌單解析失敗：${stream.title}: ${error.message}`)
          result.failedItems.push({
            videoId: stream.id,
            date: formatDateForDisplay(stream.time),
            title: stream.title,
            reason: getSimplifiedErrorReason(error.message)
          })
        }
      }

      // Step 5: Insert setlists to database
      if (setlistResults.length > 0) {
        const insertResult = await dataProcessor.processAndInsertSetlists(setlistResults, env)
        result.setlistUpdated = insertResult.success
        result.newSetlists = insertResult.insertedCount

        // 檢測初回歌曲
        result.debutSongs = await detectDebutSongs(setlistResults, result.setlistItems, db)

        logger.info('SETLIST', `更新完成: ${result.newSetlists} 個項目`, {
          inserted: result.newSetlists,
          debuts: result.debutSongs?.length || 0
        })
      }
    }

    // Step 6: Send Discord notification
    if (result.streamlistUpdated || result.setlistUpdated) {
      await sendDiscordNotification(env, {
        type: 'auto-update',
        result,
        success: true
      })
    }

  } catch (error) {
    logger.error('CRON', `自動更新失敗: ${error.message}`, {
      err: { message: error.message, stack: error.stack }
    })
    result.errors.push(error.message)
    throw error

  } finally {
    result.executionTime = Date.now() - startTime

    const status = result.errors?.length > 0 ? 'WARN' : 'INFO'
    logger.log(status, 'CRON', `自動更新完成`, {
      duration: result.executionTime,
      streams: result.newStreams,
      setlists: result.newSetlists,
      errors: result.errors?.length || 0
    })

    // 結束請求，觸發上傳
    await logger.endRequest()
  }

  return result
}

/**
 * Polling check for live stream end detection
 * 檢查 Polling 窗口內的直播是否已結束，若結束則觸發歌單解析
 * @param {Object} env - Environment variables
 * @returns {Promise<Object>} Polling result
 */
export async function runPollingCheck(env) {
  const startTime = Date.now()

  // 初始化 logger
  let logger = getLogger()
  if (!logger) {
    logger = initLogger(env)
  }
  logger.startRequest()

  logger.info('POLLING', '開始 Polling 檢查直播結束')

  const db = new Database(env)
  const dataFetcher = new DataFetcher(env, db)
  const dataProcessor = new DataProcessor()

  const result = {
    timestamp: new Date().toISOString(),
    checkedStreams: 0,
    endedStreams: 0,
    parsedSetlists: 0,
    errors: [],
    executionTime: 0
  }

  try {
    // Step 1: 查詢所有待處理的歌枠（setlistComplete = false）
    const pendingStreams = await dataFetcher.fetchPendingStreams('all')

    if (pendingStreams.length === 0) {
      logger.info('POLLING', '沒有待處理的歌枠')
      return result
    }

    // Step 1.5: 修正 pending stream 的時間（安全網）
    // 若資料庫的 time 與 YTID 的 scheduledStartTime 不同，更新資料庫
    for (const stream of pendingStreams) {
      try {
        const videoInfo = await dataFetcher.getVideoInfo(stream.id)
        const scheduledStartTime = videoInfo?.liveStreamingDetails?.scheduledStartTime
        if (scheduledStartTime && scheduledStartTime !== stream.time) {
          logger.info('POLLING', `修正直播時間: ${stream.id}`, {
            舊時間: stream.time,
            新時間: scheduledStartTime
          })
          await db.execute(
            'UPDATE streamlist SET time = ? WHERE streamID = ?',
            [iso8601ToMySQL(scheduledStartTime), stream.id]
          )
          stream.time = scheduledStartTime
        }
      } catch (error) {
        logger.warn('POLLING', `時間修正查詢失敗: ${stream.id}`, { err: { message: error.message } })
      }
    }

    // Step 2: 篩選在 Polling 窗口內的直播（streamTime + 3h ~ +7h）
    const now = new Date()
    const streamsInWindow = pendingStreams.filter(stream => {
      const streamTime = new Date(stream.time)
      const windowStart = new Date(streamTime.getTime() + 3 * 60 * 60 * 1000) // +3h
      const windowEnd = new Date(streamTime.getTime() + 7 * 60 * 60 * 1000)   // +7h

      return now >= windowStart && now <= windowEnd
    })

    if (streamsInWindow.length === 0) {
      logger.info('POLLING', '沒有在 Polling 窗口內的直播', {
        pending: pendingStreams.length
      })
      return result
    }

    logger.info('POLLING', `${streamsInWindow.length} 個直播在 Polling 窗口內`, {
      total: pendingStreams.length,
      inWindow: streamsInWindow.length
    })

    result.checkedStreams = streamsInWindow.length

    // Step 3: 對每個直播查詢 YTID /live-details
    for (const stream of streamsInWindow) {
      try {
        // Direct function call (no more Service Binding)
        const liveDetails = await getLiveDetails(stream.id, env)

        if (!liveDetails) {
          logger.warn('POLLING', `查詢 live-details 失敗: ${stream.id}`)
          continue
        }

        // Step 4: 檢查 actualEndTime 是否存在
        if (!liveDetails.isEnded) {
          logger.info('POLLING', `直播尚未結束: ${stream.title}`, {
            videoId: stream.id,
            isLive: liveDetails.isLive
          })
          continue
        }

        // 直播已結束，執行歌單解析
        logger.info('POLLING', `直播已結束，開始解析歌單: ${stream.title}`, {
          videoId: stream.id,
          actualEndTime: liveDetails.actualEndTime
        })

        result.endedStreams++

        // 解析歌單
        const setlistResult = await dataProcessor.parseSetlistForStream(stream, env)

        if (setlistResult && setlistResult.length > 0) {
          // 寫入資料庫
          const formattedEntries = setlistResult.map(item => ({
            streamID: stream.id,
            trackNo: item.trackNo,
            segmentNo: item.segmentNo || 1,
            songID: item.songID,
            note: item.note || null
          }))

          await dataProcessor.batchCreateSetlist(formattedEntries, env)
          await dataProcessor.updateStreamSetlistComplete(stream.id, true, env)

          result.parsedSetlists++

          logger.info('POLLING', `歌單解析成功: ${setlistResult.length} 首歌`, {
            videoId: stream.id,
            songCount: setlistResult.length
          })

          // 發送 Discord 通知
          const debutSongs = setlistResult
            .filter(item => item.note && item.note.includes('初回'))
            .map(item => ({
              trackNo: item.trackNo,
              songName: item.songName || '未知歌曲',
              artist: item.artist || '未知歌手'
            }))

          await sendDiscordNotification(env, {
            type: 'polling-parse',
            success: true,
            streamID: stream.id,
            title: stream.title,
            songCount: setlistResult.length,
            debutSongs: debutSongs.length > 0 ? debutSongs : undefined
          })
        } else {
          logger.warn('POLLING', `未找到歌單留言: ${stream.title}`, {
            videoId: stream.id
          })
          // 不標記為完成，下次 Cron 會重試
        }

      } catch (error) {
        logger.error('POLLING', `處理失敗: ${stream.title}`, {
          videoId: stream.id,
          err: { message: error.message }
        })
        result.errors.push(`${stream.id}: ${error.message}`)
      }
    }

  } catch (error) {
    logger.error('POLLING', `Polling 檢查失敗: ${error.message}`, {
      err: { message: error.message, stack: error.stack }
    })
    result.errors.push(error.message)
    throw error

  } finally {
    result.executionTime = Date.now() - startTime

    const status = result.errors.length > 0 ? 'WARN' : 'INFO'
    logger.log(status, 'POLLING', 'Polling 檢查完成', {
      duration: result.executionTime,
      checked: result.checkedStreams,
      ended: result.endedStreams,
      parsed: result.parsedSetlists,
      errors: result.errors.length
    })

    await logger.endRequest()
  }

  return result
}

/**
 * Format date for display (YYYYMMDD format)
 */
function formatDateForDisplay(isoDateString) {
  const date = new Date(isoDateString)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/**
 * Generate mock setlist for testing mode
 */
function generateMockSetlist(stream) {
  return [
    {
      date: stream.time,
      trackNo: 1,
      song: '測試歌曲A',
      singer: '測試歌手1',
      note: '假資料',
      YTLink: `https://www.youtube.com/watch?v=${stream.id}`
    },
    {
      date: stream.time,
      trackNo: 2,
      song: '測試歌曲B',
      singer: '測試歌手2',
      note: '假資料',
      YTLink: `https://www.youtube.com/watch?v=${stream.id}`
    }
  ]
}

/**
 * Get simplified error reason for display
 */
function getSimplifiedErrorReason(errorMessage) {
  if (errorMessage.includes('could not be found') || errorMessage.includes('private')) {
    return '影片已私人或刪除'
  }
  if (errorMessage.includes('No setlist found')) {
    return '未找到歌單留言'
  }
  if (errorMessage.includes('Lambda') || errorMessage.includes('fuzzy')) {
    return 'Lambda 匹配錯誤'
  }
  return '處理錯誤'
}

/**
 * Renew PubSubHubbub subscription
 * YouTube PubSubHubbub 訂閱有效期為 5 天，每 4 天自動續訂
 * @param {Object} env - Environment variables
 * @returns {Promise<boolean>} Success status
 */
export async function renewPubSubSubscription(env) {
  const logger = getLogger() || initLogger(env)

  // 檢查是否需要續訂（每 4 天一次）
  const today = new Date()
  const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24))

  if (dayOfYear % 4 !== 0) {
    logger.info('PUBSUB', '今日無需續訂', { dayOfYear, nextRenewal: 4 - (dayOfYear % 4) })
    return true
  }

  logger.info('PUBSUB', '開始 PubSubHubbub 訂閱續訂')

  const CHANNELS = [
    { id: 'UC7A7bGRVdIwo93nqnA3x-OQ', name: '主頻道' },
    { id: 'UCBOGwPeBtaPRU59j8jshdjQ', name: '副頻道1' },
    { id: 'UC2cgr_UtYukapRUt404In-A', name: '副頻道2' }
  ]
  const CALLBACK_URL = getSecret(env, 'PUBSUB_CALLBACK_URL') || 'https://m-b.win/webhook/youtube'
  const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe'

  let allSuccess = true

  for (const channel of CHANNELS) {
    const TOPIC_URL = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channel.id}`

    try {
      const formData = new URLSearchParams()
      formData.append('hub.callback', CALLBACK_URL)
      formData.append('hub.topic', TOPIC_URL)
      formData.append('hub.verify', 'async')
      formData.append('hub.mode', 'subscribe')
      formData.append('hub.lease_seconds', '432000') // 5 天

      const response = await fetch(HUB_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData.toString()
      })

      if (response.status === 202 || response.status === 204) {
        logger.info('PUBSUB', '訂閱續訂請求成功', {
          status: response.status,
          channelId: channel.id,
          channelName: channel.name
        })
      } else {
        const errorText = await response.text()
        logger.error('PUBSUB', '訂閱續訂失敗', {
          status: response.status,
          channelId: channel.id,
          channelName: channel.name,
          error: errorText
        })
        allSuccess = false
      }

    } catch (error) {
      logger.error('PUBSUB', '訂閱續訂錯誤', {
        channelId: channel.id,
        channelName: channel.name,
        err: { message: error.message }
      })
      allSuccess = false
    }
  }

  return allSuccess
}

/**
 * Detect debut songs from setlist results
 */
async function detectDebutSongs(setlistResults, streamMetadata, db) {
  const debutSongs = []

  for (let i = 0; i < setlistResults.length; i++) {
    const setlistArray = setlistResults[i]
    if (!Array.isArray(setlistArray) || setlistArray.length === 0) continue

    const metadata = streamMetadata[i]
    if (!metadata) continue

    const videoId = metadata.videoId
    const date = metadata.date

    // Find songs with "初回" note
    const debutItems = setlistArray.filter(item => item.note && item.note.includes('初回'))
    if (debutItems.length === 0) continue

    // Direct DB query (no more Hyperdrive HTTP call)
    const debutSongsInVideo = []
    for (const item of debutItems) {
      try {
        const song = await db.first(
          'SELECT songName, artist FROM songlist WHERE songID = ?',
          [item.songID]
        )

        if (song) {
          debutSongsInVideo.push({
            trackNo: item.trackNo,
            songName: song.songName,
            artist: song.artist
          })
        }
      } catch (error) {
        console.error(`Failed to fetch song details for songID ${item.songID}:`, error)
      }
    }

    if (debutSongsInVideo.length > 0) {
      debutSongs.push({
        videoId,
        date,
        songs: debutSongsInVideo
      })
    }
  }

  return debutSongs
}
