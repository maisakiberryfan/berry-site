/**
 * @fileoverview Auto-update logic for streamlist and setlist (v2 - Database driven)
 */

import { DataFetcher } from './data-fetcher.js'
import { DataProcessor } from '../utils/data-processor.js'
import { sendDiscordNotification } from '../utils/discord-notifier.js'
// MIGRATED to yt-setlist-discord (2026-05-02): sendSetlistComment removed
import { verifyRecentSetlists, sendWikiDiffNotification } from '../utils/wiki-verifier.js'
import { getLiveDetails } from '../utils/youtube-api.js'
import { Database } from '../utils/database.js'
import { getSecret } from '../platform.js'
import { iso8601ToMySQL, mysqlToISO8601 } from '../utils/middleware.js'
import { saveThumbnail } from '../utils/thumbnail.js'
import { CONFIG } from '../config.js'

// 防線攔截通知去重：blocked 的歌枠保持 pending（等 KL 留言出現後仍要重試解析），
// 但 polling 每 10 分鐘＋每日 cron 都會再攔一次——同一 instance 內只通知一次。
// module scope 在 warm Lambda/Worker 跨 invocation 存活；冷啟後重發一次可接受。
const notifiedBlockedStreams = new Set()

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
  console.log(`[CRON] 開始自動更新 (mode: ${mode}, trigger: ${triggerType})`)

  // 在每日 Cron 時嘗試續訂 PubSubHubbub（每 4 天一次）
  if (triggerType === 'CRON') {
    try {
      await renewPubSubSubscription(env)
    } catch (subError) {
      console.warn(`[PUBSUB] 訂閱續訂檢查失敗（非致命）: ${subError.message}`)
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
    blockedItems: [],
    debutSongs: []
  }

  try {
    // Step 1: Get new videos
    let newVideos = []
    const pubsubVideoId = options.pubsubVideoId

    if (pubsubVideoId) {
      // PubSub 模式：直接用 videoId 查詢單一影片
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
                console.log(`[STREAM] Lambda: 跳過等待 scheduledStartTime, 交由 Polling 修正 (${pubsubVideoId})`)
              } else {
                console.log(`[STREAM] 缺少 scheduledStartTime, 2 分鐘後重試 (${pubsubVideoId})`)
                await new Promise(resolve => setTimeout(resolve, 120_000))
                try {
                  const retryVideo = await dataFetcher.getVideoInfo(pubsubVideoId)
                  if (retryVideo?.liveStreamingDetails?.scheduledStartTime) {
                    video = { ...retryVideo, categories: video.categories }
                  } else {
                    console.warn(`[STREAM] 重試仍無 scheduledStartTime, 使用 publishedAt (${pubsubVideoId})`)
                  }
                } catch (retryError) {
                  console.warn(`[STREAM] 重試查詢失敗: ${retryError.message}`)
                }
              }
            }

            newVideos = [video]
          }
        }
      } catch (error) {
        console.warn(`[STREAM] PubSub 影片查詢失敗: ${error.message}, 改用 /newvideos`)
        newVideos = await dataFetcher.fetchNewVideos()
      }
    } else {
      // Cron 模式：查詢所有新影片
      newVideos = await dataFetcher.fetchNewVideos()
    }

    // fetchNewVideos 回傳原始 YouTube API 物件，需補上分類
    for (const video of newVideos) {
      if (!video.categories) {
        const title = video.snippet?.title || ''
        const channelId = video.snippet?.channelId
        video.categories = dataProcessor.categorizeStream(title, channelId)
      }
    }

    // Free chat（常駐待機所）過濾：upcoming 且排程在 horizon 之後（如 Freee chat 排 2027）。
    // 一旦入庫，其遠未來 time 會永遠霸佔 ORDER BY time DESC（首頁最新影片）。
    const FREECHAT_HORIZON_MS = CONFIG.freechatFilter.horizonDays * 24 * 60 * 60 * 1000
    newVideos = (newVideos || []).filter(video => {
      const scheduled = video.liveStreamingDetails?.scheduledStartTime
      const isFarFuture = scheduled && (new Date(scheduled).getTime() - Date.now() > FREECHAT_HORIZON_MS)
      if (video.snippet?.liveBroadcastContent === 'upcoming' && isFarFuture) {
        console.log(`[STREAM] 跳過 free chat / 遠期排程影片: ${video.id} (scheduled ${scheduled})`)
        return false
      }
      return true
    })

    if (newVideos && newVideos.length > 0) {
      console.log(`[STREAM] 發現 ${newVideos.length} 部新影片`)
    }

    // Step 2: Write new streams to database
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

        console.log(`[STREAM] 寫入結果: ${writeResult.insertedCount} 新增 / ${newVideos.length} 總計`)
      } catch (error) {
        console.error(`[STREAM] 寫入失敗: ${error.message}`)
        result.errors.push(`Streamlist 寫入失敗: ${error.message}`)
      }

      // Step 2.5: Download thumbnails to S3
      for (const video of newVideos) {
        try {
          await saveThumbnail(video.id, env)
        } catch (e) {
          console.warn(`[THUMBNAIL] 縮圖下載失敗: ${video.id} - ${e.message}`)
        }
      }
    }

    // Step 3: Query pending streams from database
    const singingStreams = await dataFetcher.fetchPendingStreams(mode)

    if (singingStreams.length > 0) {
      console.log(`[SETLIST] 發現 ${singingStreams.length} 個待解析歌枠`)

      // Step 4: Parse setlists for singing streams using Lambda fuzzy matching
      const setlistResults = []

      for (const stream of singingStreams) {
        try {
          console.log(`[SETLIST] 開始解析: ${stream.title} (${stream.id})`)

          const parseResult = await dataProcessor.parseSetlistForStream(stream, env)

          if (parseResult && parseResult.items && parseResult.items.length > 0) {
            // 先寫入 DB、成功後才標記完成；順序不可反，否則寫入失敗的歌枠會從 pending 永久消失
            await dataProcessor.batchCreateSetlist(parseResult.items, env)

            try {
              await dataProcessor.updateStreamSetlistComplete(stream.id, true, env)
            } catch (updateError) {
              console.warn(`[SETLIST] 更新 setlistComplete 失敗: ${stream.id} - ${updateError.message}`)
            }

            setlistResults.push(parseResult.items)
            result.setlistItems.push({
              videoId: stream.id,
              date: formatDateForDisplay(stream.time),
              title: stream.title,
              songCount: parseResult.items.length,
              skippedLines: parseResult.skippedLines || []
            })
            result.newSetlists += parseResult.items.length

            console.log(`[SETLIST] 解析成功: ${parseResult.items.length} 首歌 (${stream.id})`)
          } else if (parseResult?.blocked) {
            // 防線攔截（熔斷/無戳全滅）：不入庫，但要通知（誤擋真歌單時能及時發現、force 重解析）。
            // 同一場只通知一次——stream 保持 pending，之後每輪解析都會再攔到。
            // 去重標記在 Step 6 通知「送達成功」後才寫入，送失敗下輪重試
            if (!notifiedBlockedStreams.has(stream.id)) {
              result.blockedItems.push({
                videoId: stream.id,
                date: formatDateForDisplay(stream.time),
                title: stream.title,
                reason: parseResult.blocked.reason,
                commentAuthor: parseResult.blocked.commentAuthor,
                skippedLines: parseResult.blocked.skippedLines || []
              })
            }
          } else {
            result.failedItems.push({
              videoId: stream.id,
              date: formatDateForDisplay(stream.time),
              title: stream.title,
              reason: '未找到歌單留言'
            })
          }
        } catch (error) {
          console.error(`[SETLIST] 解析失敗: ${stream.title} - ${error.message}`)
          result.errors.push(`歌單解析失敗：${stream.title}: ${error.message}`)
          result.failedItems.push({
            videoId: stream.id,
            date: formatDateForDisplay(stream.time),
            title: stream.title,
            reason: getSimplifiedErrorReason(error.message)
          })
        }
      }

      // Step 5: 統計與初回歌曲檢測（寫入已在 Step 4 逐 stream 完成）
      if (setlistResults.length > 0) {
        result.setlistUpdated = true

        // 檢測初回歌曲
        result.debutSongs = await detectDebutSongs(setlistResults, result.setlistItems, db)

        console.log(`[SETLIST] 更新完成: ${result.newSetlists} 項 (debuts: ${result.debutSongs?.length || 0})`)
      }
    }

    // Step 6: Send Discord notification（防線攔截也要發——不入庫但不可靜默）
    if (result.streamlistUpdated || result.setlistUpdated || result.blockedItems.length > 0) {
      const sent = await sendDiscordNotification(env, {
        type: 'auto-update',
        result,
        success: true
      })
      // 送達成功才標記攔截已通知；失敗（網路/Discord 4xx）下輪重試
      if (sent) {
        result.blockedItems.forEach(item => notifiedBlockedStreams.add(item.videoId))
      }
    }

    // Step 7: Wiki 歌單二次校正（驗證近期已解析的歌枠）
    try {
      const wikiResult = await verifyRecentSetlists(env)
      if (wikiResult.mismatches > 0) {
        await sendWikiDiffNotification(env, wikiResult.details)
      }
      if (wikiResult.verified > 0 || wikiResult.mismatches > 0) {
        console.log(`[WIKI] verified=${wikiResult.verified}, mismatches=${wikiResult.mismatches}, skipped=${wikiResult.skipped}`)
      }
    } catch (wikiError) {
      console.error(`[WIKI] 驗證失敗（非致命）: ${wikiError.message}`)
    }

    // Step 8: 近 14 天縮圖兜底重刷（每日 CRON 限定）——VT 換圖不一定伴隨
    // 標題變更（PubSub）或直播結束（polling），這裡兜住「幾天後才慢慢換圖」型。
    // saveThumbnail 內建 hash 比對：未變更零成本，變更才上傳＋invalidate
    if (triggerType === 'CRON') {
      try {
        const recent = await db.query(
          'SELECT streamID FROM streamlist WHERE time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY)'
        )
        let refreshed = 0
        for (const row of recent) {
          try {
            if (await saveThumbnail(row.streamID, env)) refreshed++
          } catch { /* 單支失敗不擋其餘 */ }
        }
        if (refreshed > 0) console.log(`[THUMBNAIL] 近 14 天兜底重刷: ${refreshed}/${recent.length} 支有更新`)
      } catch (thumbError) {
        console.warn(`[THUMBNAIL] 縮圖兜底失敗（非致命）: ${thumbError.message}`)
      }
    }

  } catch (error) {
    console.error(`[CRON] 自動更新失敗: ${error.message}`)
    result.errors.push(error.message)
    throw error

  } finally {
    result.executionTime = Date.now() - startTime
    const status = result.errors?.length > 0 ? 'WARN' : 'OK'
    console.log(`[CRON] 自動更新完成 (${status}) ${result.executionTime}ms | streams: ${result.newStreams} | setlists: ${result.newSetlists} | errors: ${result.errors?.length || 0}`)
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
  console.log('[POLLING] 開始 Polling 檢查直播結束')

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
      return result
    }

    // Step 1.5: 修正 pending stream 的時間（安全網）
    // 寬鬆粗篩：只查「近期」pending（DB time 在 now-2d ~ now+7d）。
    // 時間錯誤頂多是 publishedAt/scheduledStartTime 之差（同量級日期），不會錯出此範圍；
    // 歷史積壓的 pending（早已過窗口）無修正意義，免得每 10 分鐘輪番空查 YouTube API
    const nowMs = Date.now()
    const recentPending = pendingStreams.filter(stream => {
      const t = new Date(mysqlToISO8601(stream.time)).getTime()
      return Number.isFinite(t) &&
        t >= nowMs - 2 * 24 * 3600_000 &&
        t <= nowMs + 7 * 24 * 3600_000
    })

    for (const stream of recentPending) {
      try {
        const videoInfo = await dataFetcher.getVideoInfo(stream.id)
        const scheduledStartTime = videoInfo?.liveStreamingDetails?.scheduledStartTime
        // stream.time 是 MySQL DATETIME 字串（dateStrings），須轉 ISO 比 epoch，直接比字串永不相等
        const dbTimeMs = new Date(mysqlToISO8601(stream.time)).getTime()
        if (scheduledStartTime && new Date(scheduledStartTime).getTime() !== dbTimeMs) {
          console.log(`[POLLING] 修正直播時間: ${stream.id} (${stream.time} -> ${scheduledStartTime})`)
          await db.execute(
            'UPDATE streamlist SET time = ? WHERE streamID = ?',
            [iso8601ToMySQL(scheduledStartTime), stream.id]
          )
          stream.time = scheduledStartTime
        }
      } catch (error) {
        console.warn(`[POLLING] 時間修正查詢失敗: ${stream.id} - ${error.message}`)
      }
    }

    // Step 2: 篩選在 Polling 窗口內的直播（streamTime + 3h ~ +7h）
    const now = new Date()
    const streamsInWindow = pendingStreams.filter(stream => {
      // mysqlToISO8601 確保 MySQL 字串以 UTC 解讀（ISO 輸入則原樣通過）
      const streamTime = new Date(mysqlToISO8601(stream.time))
      const windowStart = new Date(streamTime.getTime() + 3 * 60 * 60 * 1000) // +3h
      const windowEnd = new Date(streamTime.getTime() + 7 * 60 * 60 * 1000)   // +7h

      return now >= windowStart && now <= windowEnd
    })

    if (streamsInWindow.length === 0) {
      return result
    }

    console.log(`[POLLING] ${streamsInWindow.length} 個直播在 Polling 窗口內 (pending: ${pendingStreams.length})`)

    result.checkedStreams = streamsInWindow.length

    // Step 3: 對每個直播查詢 live-details
    for (const stream of streamsInWindow) {
      try {
        const liveDetails = await getLiveDetails(stream.id, env)

        if (!liveDetails) {
          console.warn(`[POLLING] 查詢 live-details 失敗: ${stream.id}`)
          continue
        }

        // Step 4: 檢查 actualEndTime 是否存在
        if (!liveDetails.isEnded) {
          continue
        }

        // 直播已結束，執行歌單解析
        console.log(`[POLLING] 直播已結束，開始解析: ${stream.title} (${stream.id})`)

        result.endedStreams++

        // 解析歌單（傳入已查得的 liveDetails，避免 resolveParseTiming 重查同一影片）
        const parseResult = await dataProcessor.parseSetlistForStream(stream, env, { liveDetails })

        if (parseResult && parseResult.items && parseResult.items.length > 0) {
          // 寫入資料庫
          const formattedEntries = parseResult.items.map(item => ({
            streamID: stream.id,
            trackNo: item.trackNo,
            segmentNo: item.segmentNo || 1,
            songID: item.songID,
            note: item.note || null,
            // ?? 而非 ||：第一首歌 0:00 開始時 startTime=0，|| 會把 0 洗成 NULL
            startTime: item.startTime ?? null,
            endTime: item.endTime ?? null
          }))

          await dataProcessor.batchCreateSetlist(formattedEntries, env)
          await dataProcessor.updateStreamSetlistComplete(stream.id, true, env)

          result.parsedSetlists++

          console.log(`[POLLING] 歌單解析成功: ${parseResult.items.length} 首歌 (${stream.id})`)

          // 直播結束＝VT 換正式縮圖的高峰時點，重刷一次（hash 比對，有變才上傳＋清快取）
          try {
            await saveThumbnail(stream.id, env)
          } catch (thumbError) {
            console.warn(`[THUMBNAIL] 結束後重刷失敗（非致命）: ${stream.id} - ${thumbError.message}`)
          }

          /* MIGRATED to yt-setlist-discord (2026-05-02): sendSetlistComment removed
          // 發送歌單留言到 Discord
          const setlistWebhookUrl = getSecret(env, 'DISCORD_SETLIST_WEBHOOK_URL')
          if (setlistWebhookUrl) {
            sendSetlistComment(setlistWebhookUrl, stream, parseResult.setlistComment, parseResult.commentAuthor)
              .catch(err => console.error(`[DISCORD] 歌單留言通知失敗: ${err.message}`))
          }
          */

          // 發送 Discord 通知
          const debutSongs = parseResult.items
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
            songCount: parseResult.items.length,
            skippedLines: parseResult.skippedLines?.length ? parseResult.skippedLines : undefined,
            debutSongs: debutSongs.length > 0 ? debutSongs : undefined
          })
        } else if (parseResult?.blocked) {
          // 防線攔截：不入庫但要通知（誤擋可用 force 重解析）；同場只通知一次防 10 分鐘輪詢轟炸。
          // 附上被擋的行內容供人工判斷是否誤擋；送達成功才標記，失敗下輪重試
          console.warn(`[POLLING] 防線攔截: ${parseResult.blocked.reason} (${stream.id})`)
          if (!notifiedBlockedStreams.has(stream.id)) {
            const skippedInfo = parseResult.blocked.skippedLines?.length
              ? `\n被擋的行: ${parseResult.blocked.skippedLines.join('、').substring(0, 300)}`
              : ''
            const sent = await sendDiscordNotification(env, {
              type: 'polling-parse',
              success: false,
              streamID: stream.id,
              title: stream.title,
              error: `🛡️ ${parseResult.blocked.reason}（留言 by ${parseResult.blocked.commentAuthor || '?'}）${skippedInfo}`
            })
            if (sent) notifiedBlockedStreams.add(stream.id)
          }
        } else {
          console.warn(`[POLLING] 未找到歌單留言: ${stream.title} (${stream.id})`)
        }

      } catch (error) {
        console.error(`[POLLING] 處理失敗: ${stream.title} - ${error.message}`)
        result.errors.push(`${stream.id}: ${error.message}`)
      }
    }

  } catch (error) {
    console.error(`[POLLING] Polling 檢查失敗: ${error.message}`)
    result.errors.push(error.message)
    throw error

  } finally {
    result.executionTime = Date.now() - startTime
    const status = result.errors.length > 0 ? 'WARN' : 'OK'
    console.log(`[POLLING] 完成 (${status}) ${result.executionTime}ms | checked: ${result.checkedStreams} | ended: ${result.endedStreams} | parsed: ${result.parsedSetlists} | errors: ${result.errors.length}`)
  }

  return result
}

/**
 * Format date for display (YYYYMMDD, JST)
 * Discord 通知用——配信日期以 JST 表記（與 wiki／官方日曆一致），
 * 否則台灣深夜（JST 0~9 時）的場次會顯示成前一天
 */
function formatDateForDisplay(isoDateString) {
  // 輸入可能是 ISO（YouTube API）或 MySQL DATETIME 字串（DB）——後者需顯式以 UTC 解讀
  const date = new Date(mysqlToISO8601(isoDateString))
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  const year = jst.getUTCFullYear()
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const day = String(jst.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
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
  // 檢查是否需要續訂（每 4 天一次）
  const today = new Date()
  const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24))

  if (dayOfYear % 4 !== 0) {
    return true
  }

  console.log('[PUBSUB] 開始 PubSubHubbub 訂閱續訂')

  const CALLBACK_URL = getSecret(env, 'PUBSUB_CALLBACK_URL') || 'https://m-b.win/webhook/youtube'
  const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe'

  let allSuccess = true

  for (const channelId of CONFIG.berryChannels) {
    const TOPIC_URL = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`

    try {
      const formData = new URLSearchParams()
      formData.append('hub.callback', CALLBACK_URL)
      formData.append('hub.topic', TOPIC_URL)
      formData.append('hub.verify', 'async')
      formData.append('hub.mode', 'subscribe')
      formData.append('hub.lease_seconds', '432000') // 5 天
      // hub.secret：之後的通知會帶 X-Hub-Signature（HMAC-SHA1），webhook 端驗證防偽造
      const hubSecret = getSecret(env, 'TRIGGER_TOKEN')
      if (hubSecret) formData.append('hub.secret', hubSecret)

      const response = await fetch(HUB_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData.toString()
      })

      if (response.status === 202 || response.status === 204) {
        console.log(`[PUBSUB] 訂閱續訂成功: ${channelId} (${response.status})`)
      } else {
        const errorText = await response.text()
        console.error(`[PUBSUB] 訂閱續訂失敗: ${channelId} (${response.status}) ${errorText}`)
        allSuccess = false
      }

    } catch (error) {
      console.error(`[PUBSUB] 訂閱續訂錯誤: ${channelId} - ${error.message}`)
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
