/**
 * Berry Site - Unified Hono App
 * Consolidates Worker + Hyperdrive + YTID into a single platform-agnostic app
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { CONFIG } from './config.js'
import { Database, createErrorResponse } from './utils/database.js'
import { getSecret } from './platform.js'
import { extractVideoId } from './utils/url-helpers.js'
import { sendDiscordNotification } from './utils/discord-notifier.js'
// MIGRATED to yt-setlist-discord (2026-05-02): sendSetlistComment removed
import { getVideoComments } from './utils/youtube-comments.js'
import { mysqlToISO8601 } from './utils/middleware.js'
import {
  getVideoInfo, getNewVideosFromChannels,
  getLiveDetails, preCategory, makeYouTubeAPIRequest
} from './utils/youtube-api.js'

// Import Hyperdrive route handlers
import {
  getSonglist, getSongById, createSong, updateSong, deleteSong,
  getSonglistOptimized, getArtists
} from './routes/songlist.js'
import {
  getStreamlist, getStreamById, createStream, updateStream, deleteStream,
  bulkUpdateCategories, getPendingStreams, getLatestStream
} from './routes/streamlist.js'
import {
  getSetlist, getSetlistManifest, createSetlistEntry, updateSetlistEntry, deleteSetlistEntry,
  reorderSetlistSegment
} from './routes/setlist.js'
import aliasesApp from './routes/aliases.js'

const app = new Hono()

// ─── Middleware ───

app.use('*', logger())

app.use('*', cors({
  origin: CONFIG.cors.allowedOrigins,
  allowMethods: CONFIG.cors.allowedMethods,
  allowHeaders: CONFIG.cors.allowedHeaders,
  exposeHeaders: CONFIG.cors.exposeHeaders
}))

app.options('*', (c) => c.text('', 204))

// 全域錯誤處理。
// 必須掛 onError 而非 `app.use('*', ...)` 中介層：Hono 的 compose 在每層 dispatch 都包
// try/catch，捕到 Error 時直接交給 onError 且**不 re-throw**——錯誤在最靠近拋出點的那層
// 就被吞掉，永遠到不了外層中介層。舊寫法實測從未生效（回應是內建 onError 的
// text/plain "Internal Server Error"），分類與 409 語意等於沒有。
app.onError((err, c) => {
  // 自帶回應的錯誤（HTTPException 等）維持 Hono 內建語意——原本走內建 onError 時即如此，
  // 覆寫後不處理會讓這類錯誤的狀態碼與 body 被吃掉
  if (err && typeof err.getResponse === 'function') {
    const res = err.getResponse()
    return c.newResponse(res.body, res)
  }

  console.error('API Error:', err)

  const message = String(err?.message ?? '')
  // dev/test 環境才附上實際錯誤訊息（MODE 由 wrangler.toml / .env.json 注入，
  // production 為 prod）；正式環境一律回泛化訊息，不外洩 DB 與內部細節
  const isDevMode = c.env?.MODE === 'test' || c.env?.MODE === 'dev'
  const detail = isDevMode ? message : undefined

  if (message.includes('FOREIGN KEY')) {
    return c.json(
      createErrorResponse('CONSTRAINT_VIOLATION', 'Cannot delete: record is still referenced'),
      409
    )
  }

  if (message.includes('Duplicate entry')) {
    return c.json(
      createErrorResponse('DUPLICATE_ENTRY', 'Record already exists'),
      409
    )
  }

  if (message.includes('Database') || err?.code?.startsWith?.('ER_') || err?.errno) {
    return c.json(
      createErrorResponse('DATABASE_ERROR', detail || 'Database operation failed'),
      500
    )
  }

  return c.json(
    createErrorResponse('INTERNAL_ERROR', detail || 'Internal server error'),
    500
  )
})

// Security response headers
app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
})

// Rate limiting (in-memory, resets on cold start)
const rateLimits = new Map()
const RATE_WINDOW = 60_000 // 1 minute

function getRateKey(ip, tier) {
  return `${ip}:${tier}`
}

function checkRateLimit(ip, tier, maxRequests) {
  const key = getRateKey(ip, tier)
  const now = Date.now()
  let entry = rateLimits.get(key)

  if (!entry || now - entry.start > RATE_WINDOW) {
    entry = { start: now, count: 0 }
    rateLimits.set(key, entry)
  }

  entry.count++
  return entry.count <= maxRequests
}

// Rate limit: write endpoints 30/min, expensive endpoints 5/min
app.use('/api/*', async (c, next) => {
  const method = c.req.method
  const path = c.req.path

  // Skip rate limiting for read-only methods
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()

  // Cleanup stale entries on each request (lightweight, map is small)
  const cleanupNow = Date.now()
  for (const [key, entry] of rateLimits) {
    if (cleanupNow - entry.start > RATE_WINDOW * 2) rateLimits.delete(key)
  }

  // IP 來源優先序（防偽造）——限流 key 若可被請求方控制，整條限流形同虛設：
  //   1. cf-connecting-ip            CF 站，Cloudflare 覆寫填入，外部不可偽造
  //   2. requestContext.http.sourceIp Lambda（HTTP API v2），API Gateway 填入，client 不可偽造
  //   3. x-forwarded-for **末段**     僅本地/SAM local 兜底；取最接近平台的一段
  // ⚠️ 不可取 XFF 首段：CloudFront 會保留 viewer 自帶的 XFF 值於首段、真實 IP append 在後，
  //    每次請求換一個偽造首段就是一把新 rate key，30/min 上限會被完全繞過。
  const ip = c.req.header('cf-connecting-ip')
    || c.env?.requestContext?.http?.sourceIp
    || c.req.header('x-forwarded-for')?.split(',').pop()?.trim()
    || 'unknown'

  // Expensive endpoints: stricter limit
  const isExpensive = path.includes('/parse-setlist')
  const limit = isExpensive ? 5 : 30
  const tier = isExpensive ? 'expensive' : 'write'

  if (!checkRateLimit(ip, tier, limit)) {
    return c.json({ error: 'Too many requests' }, 429)
  }

  return next()
})

// Database middleware - inject db into context
app.use('*', async (c, next) => {
  c.set('db', new Database(c.env))
  await next()
})

// ─── API Routes (all under /api/) ───
const api = new Hono()

// Songlist
api.get('/songlist', getSonglist)
api.get('/songlist/artists', getArtists)
api.get('/songlist/optimized', getSonglistOptimized)
api.get('/songlist/:songID', getSongById)
api.post('/songlist', createSong)
api.put('/songlist/:songID', updateSong)
api.delete('/songlist/:songID', deleteSong)

// Streamlist
api.get('/streamlist', getStreamlist)
api.get('/streamlist/latest', getLatestStream)
api.get('/streamlist/pending', getPendingStreams)
api.get('/streamlist/:streamID', getStreamById)
api.post('/streamlist', createStream)
api.put('/streamlist/:streamID', updateStream)
api.delete('/streamlist/:streamID', deleteStream)
api.patch('/streamlist/bulk-categories', bulkUpdateCategories)

// Setlist
api.get('/setlist/manifest', getSetlistManifest)
api.get('/setlist', getSetlist)
api.post('/setlist', createSetlistEntry)
// ⚠️ 具體路徑必須排在 :trackNo 之前，否則 'reorder' 會被當成 trackNo（→ NaN → 400）
api.put('/setlist/:streamID/:segmentNo/reorder', reorderSetlistSegment)
api.put('/setlist/:streamID/:segmentNo/:trackNo', updateSetlistEntry)
api.delete('/setlist/:streamID/:segmentNo/:trackNo', deleteSetlistEntry)

// Aliases
api.route('/aliases', aliasesApp)

// Stats
api.get('/stats/last-updated', async (c) => {
  const db = c.get('db')
  try {
    const [streamlist, setlist, songlist] = await Promise.all([
      db.first('SELECT MAX(updatedAt) as lastUpdated FROM streamlist'),
      db.first('SELECT MAX(updatedAt) as lastUpdated FROM setlist_ori'),
      db.first('SELECT MAX(updatedAt) as lastUpdated FROM songlist'),
    ])
    return c.json({
      success: true,
      data: {
        streamlist: streamlist?.lastUpdated || null,
        setlist: setlist?.lastUpdated || null,
        songlist: songlist?.lastUpdated || null,
      },
    })
  } catch (error) {
    console.error('Get last updated failed:', error)
    return c.json({ success: false, error: 'Database operation failed' }, 500)
  }
})

// YTID Routes (YouTube API)

// Video info by ID
api.get('/yt', async (c) => {
  const videoId = c.req.query('id')
  if (!videoId) {
    return c.json({ message: 'YouTube API - use ?id={videoId}' })
  }
  try {
    const result = await getVideoInfo(videoId, c.env)
    return c.json(result)
  } catch (error) {
    console.error('Get video info failed:', error)
    return c.json({ error: '無法獲取影片資訊' }, 500)
  }
})

// Latest video (from streamlist DB)
api.get('/yt/latest', async (c) => {
  try {
    const db = c.get('db')
    // time 上限（與 auto-update 寫入端過濾共用 CONFIG.freechatFilter.horizonDays）：
    // free chat 的 scheduledStartTime 排在遠未來（如 2027），一旦入庫會永遠霸佔「最新影片」
    const rows = await db.query(
      `SELECT streamID, title, time, categories FROM streamlist WHERE time <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${CONFIG.freechatFilter.horizonDays} DAY) ORDER BY time DESC LIMIT 1`
    )
    if (!rows || rows.length === 0) {
      return c.json({ error: 'No streams found' }, 404)
    }
    const latest = rows[0]
    return c.json({
      success: true,
      data: {
        videoId: latest.streamID,
        title: latest.title,
        time: mysqlToISO8601(latest.time),
        categories: typeof latest.categories === 'string'
          ? JSON.parse(latest.categories) : latest.categories
      }
    })
  } catch (error) {
    console.error('Get latest video failed:', error)
    return c.json({ error: '無法獲取最新影片' }, 500)
  }
})

// New videos from multiple channels
api.get('/yt/newvideos', async (c) => {
  try {
    const db = c.get('db')
    const result = await getNewVideosFromChannels(c.env, db)
    const { items: newVideos, authMethods } = result

    const videosWithCategory = newVideos.map(video => {
      const unifiedTime = video.liveStreamingDetails?.scheduledStartTime || video.snippet?.publishedAt
      return {
        ...video,
        category: preCategory(video.snippet?.title),
        time: unifiedTime
      }
    })

    return c.json({
      items: videosWithCategory,
      _metadata: {
        authMethods,
        totalCount: videosWithCategory.length,
        baselineTime: result.baselineTime
      }
    })
  } catch (error) {
    console.error('Get new videos failed:', error)
    return c.json({ error: '無法獲取新影片資訊' }, 500)
  }
})

// Live details
api.get('/yt/live-details', async (c) => {
  const videoId = c.req.query('id')
  if (!videoId) return c.json({ error: 'Missing video ID parameter' }, 400)

  try {
    const details = await getLiveDetails(videoId, c.env)
    if (!details) return c.json({ error: 'Video not found' }, 404)
    return c.json(details)
  } catch (error) {
    console.error('Get live details failed:', error)
    return c.json({ error: 'Failed to get live details' }, 500)
  }
})

// Parse setlist（debug 端點：會實際寫入 songlist/setlist，比照 /trigger-* 需 token）
api.post('/parse-setlist', async (c) => {
  if (!validateTriggerToken(c)) return c.json({ error: 'Forbidden' }, 403)

  try {
    const { youtubeUrl } = await c.req.json()
    if (!youtubeUrl) return c.json({ error: 'YouTube URL 為必填項目' }, 400)

    const videoId = extractVideoId(youtubeUrl)
    if (!videoId) return c.json({ error: '無效的 YouTube URL' }, 400)

    const stream = {
      id: videoId,
      title: `Debug: ${youtubeUrl}`,
      publishedAt: new Date().toISOString(),
      url: youtubeUrl
    }

    const { DataProcessor } = await import('./utils/data-processor.js')
    const dataProcessor = new DataProcessor()
    const setlistResult = await dataProcessor.parseSetlistForStream(stream, c.env)

    if (!setlistResult || !setlistResult.items || setlistResult.items.length === 0) {
      if (setlistResult?.blocked) {
        return c.json({ error: `防線攔截: ${setlistResult.blocked.reason}`, videoId }, 422)
      }
      return c.json({ error: '未找到歌單', videoId }, 404)
    }

    return c.json({
      success: true,
      videoId,
      songCount: setlistResult.items.length,
      songIDs: setlistResult.items.map(item => item.songID),
      setlistItems: setlistResult.items
    })
  } catch (error) {
    console.error('Parse setlist error:', error)
    return c.json({ error: '歌單解析失敗', details: error.message }, 500)
  }
})

/* ============================================================
 * MIGRATED to yt-setlist-discord stack (2026-05-02)
 * /api/get-comments — 手動抓 YouTube 留言（給 Discord pipeline 用）
 * 已由 yt-setlist-discord 接管
 * ============================================================
// Get comments
api.post('/get-comments', async (c) => {
  try {
    const { youtubeUrl } = await c.req.json()
    if (!youtubeUrl) return c.json({ error: 'YouTube URL 為必填項目' }, 400)

    const videoId = extractVideoId(youtubeUrl)
    if (!videoId) return c.json({ error: '無效的 YouTube URL' }, 400)

    const apiKey = getSecret(c.env, 'YOUTUBE_API_KEY')
    const comments = await getVideoComments(videoId, apiKey)

    // Filter setlist candidates
    const candidates = comments.filter(comment => {
      const text = comment.text.toLowerCase()
      return CONFIG.setlistKeywords.some(kw => text.includes(kw.toLowerCase())) &&
        (text.split('\n').length > CONFIG.commentFilter.minLines || text.length > CONFIG.commentFilter.minLength)
    }).sort((a, b) => {
      const scoreA = a.likeCount * CONFIG.commentFilter.likeWeight + a.text.length * CONFIG.commentFilter.lengthWeight
      const scoreB = b.likeCount * CONFIG.commentFilter.likeWeight + b.text.length * CONFIG.commentFilter.lengthWeight
      return scoreB - scoreA
    }).slice(0, CONFIG.limits.maxCandidates)

    // Get songlist for frontend
    const db = c.get('db')
    const songlist = await db.query('SELECT songID, songName, songNameEn, artist, artistEn FROM songlist')

    return c.json({
      videoId,
      commentCount: comments.length,
      candidates,
      sampleComments: comments.slice(0, CONFIG.limits.maxSampleComments),
      songlist
    })
  } catch (error) {
    return c.json({ error: '取得留言失敗', details: error.message }, 500)
  }
})
============================================================ */

// PubSubHubbub webhook
app.get('/webhook/youtube', (c) => {
  // Subscription verification：驗證 hub.mode 與 hub.topic，
  // 否則任何人可向 hub 發起 unsubscribe，本端點無條件 echo challenge 等於替對方確認注銷
  const challenge = c.req.query('hub.challenge')
  if (challenge) {
    const mode = c.req.query('hub.mode')
    const topic = c.req.query('hub.topic') || ''
    const isOurChannel = CONFIG.berryChannels.some(ch => topic.includes(`channel_id=${ch}`))
    if (mode === 'subscribe' && isOurChannel) {
      return c.text(challenge)
    }
    console.warn(`[PUBSUB] 拒絕訂閱驗證: mode=${mode}, topic=${topic.slice(0, 120)}`)
    return c.text('Forbidden', 404)
  }
  return c.text('OK')
})

// HMAC-SHA1 hex（PubSub X-Hub-Signature 驗證用，CF/Lambda 皆有 Web Crypto）
async function hmacSha1Hex(secret, data) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

app.post('/webhook/youtube', async (c) => {
  const body = await c.req.text()

  // 簽名驗證（hub.secret = TRIGGER_TOKEN）：2026-06-13 起所有訂閱已帶 secret
  //（手動重訂閱完成＋renewPubSubSubscription 自動續訂亦帶），無簽名＝偽造來源，一律拒絕
  const signature = c.req.header('X-Hub-Signature')
  const secret = getSecret(c.env, 'TRIGGER_TOKEN')
  // 無 secret 時無從驗證來源，一律不處理（fail-closed）；三個部署環境皆已設定此變數
  if (!secret) {
    console.error('[PUBSUB] TRIGGER_TOKEN 未設定，無法驗證簽名，不處理此通知')
    return c.text('OK', 200) // 與下方分支同策略：回 200 避免 hub 重試轟炸
  }
  if (!signature) {
    console.warn('[PUBSUB] 拒絕無簽名通知（訂閱已全面帶 hub.secret）')
    return c.text('OK', 200) // 回 200 避免 hub 重試轟炸，但不處理
  }
  const expected = 'sha1=' + await hmacSha1Hex(secret, body)
  if (!timingSafeEqualStr(signature, expected)) {
    console.warn('[PUBSUB] X-Hub-Signature 驗證失敗，忽略此通知')
    return c.text('OK', 200)
  }

  // Parse Atom feed
  const videoIdMatch = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)
  const channelIdMatch = body.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)

  if (!videoIdMatch || !channelIdMatch) {
    return c.text('OK', 200)
  }

  const videoId = videoIdMatch[1]
  const channelId = channelIdMatch[1]

  // Validate target channel
  if (!CONFIG.berryChannels.includes(channelId)) {
    return c.text('OK', 200)
  }

  // Ignore delete notifications
  if (body.includes('at:deleted-entry')) {
    return c.text('OK', 200)
  }

  console.log(`PubSub notification: videoId=${videoId}, channelId=${channelId}`)

  // 派發背景處理：
  // - CF：waitUntil
  // - Lambda：async self-invoke（entry-lambda.js 注入的 hook），立即回 200，
  //   避免同步處理超過 hub ~10s timeout 造成重試與重複處理
  // - 本地/失敗：回退同步 await
  const bgWork = async () => {
    try {
      const { runAutoUpdate } = await import('./cron-jobs/auto-update.js')
      await runAutoUpdate(c.env, 'recent', { pubsubVideoId: videoId }, 'PUBSUB')
    } catch (error) {
      console.error('PubSub background error:', error)
      await sendDiscordNotification(c.env, {
        type: 'auto-update',
        result: { errors: [error.message] },
        success: false
      }).catch(() => {})
    }
  }

  let ctx = null
  try { ctx = c.executionCtx } catch { /* Lambda adapter 無 executionCtx */ }

  if (ctx?.waitUntil) {
    ctx.waitUntil(bgWork())
  } else if (globalThis.__berryAsyncInvoke) {
    const dispatched = await globalThis.__berryAsyncInvoke({ __berryAsync: 'pubsub', videoId })
    if (!dispatched) await bgWork()
  } else {
    await bgWork()
  }

  return c.text('OK', 200)
})

// Songlist JSON proxy (for frontend)
api.get('/songlist.json', async (c) => {
  try {
    const db = c.get('db')
    const rows = await db.query(
      'SELECT songID, songName, songNameEn, artist, artistEn FROM songlist'
    )
    const songlistData = {}
    for (const row of rows) {
      const parts = [row.songName, row.artist]
      if (row.songNameEn) parts.push(row.songNameEn)
      if (row.artistEn) parts.push(row.artistEn)
      songlistData[row.songID] = parts.join('|')
    }
    return c.json({ data: songlistData })
  } catch (error) {
    console.error('Get songlist.json failed:', error)
    return c.json({ error: 'Database operation failed' }, 500)
  }
})

// Mount all API routes under /api/
app.route('/api', api)

// ─── Infrastructure Routes (no /api/ prefix) ───

// Token validation for trigger endpoints
// constant-time 字串比較（=== 會在首個不符字元提前返回，理論上可被計時側信道逐字猜出 token）
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false  // 長度非秘密
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// 只收 X-Trigger-Token header：query string 會被 CDN／API Gateway 存取日誌、
// 瀏覽器歷史與 Referer 保留，不適合承載長期憑證
function validateTriggerToken(c) {
  const token = c.req.header('X-Trigger-Token')
  const expected = getSecret(c.env, 'TRIGGER_TOKEN')
  if (!expected) return false  // 未設定時拒絕（fail closed）
  return timingSafeEqualStr(token || '', expected)
}

// Manual trigger
app.post('/trigger-update', async (c) => {
  if (!validateTriggerToken(c)) return c.json({ error: 'Forbidden' }, 403)

  try {
    const body = await c.req.json().catch(() => ({}))
    const mode = body.mode || 'recent'

    const { runAutoUpdate } = await import('./cron-jobs/auto-update.js')
    const result = await runAutoUpdate(c.env, mode, {}, 'MANUAL')

    return c.json({ success: true, result })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Manual setlist parse
app.get('/trigger-setlist-parse', async (c) => {
  if (!validateTriggerToken(c)) return c.json({ error: 'Forbidden' }, 403)
  const streamID = c.req.query('streamID')
  if (!streamID) return c.json({ error: 'Missing streamID' }, 400)

  try {
    const { DataProcessor } = await import('./utils/data-processor.js')
    const dataProcessor = new DataProcessor()

    const db = c.get('db')
    const stream = await db.first(
      'SELECT streamID, title, time, categories, note FROM streamlist WHERE streamID = ?',
      [streamID]
    )

    if (!stream) return c.json({ error: 'Stream not found' }, 404)

    const categories = typeof stream.categories === 'string' ? JSON.parse(stream.categories) : stream.categories
    const isSinging = categories?.some(cat => cat.includes('歌枠'))
    const force = !!c.req.query('force')
    if (!isSinging && !force) {
      return c.json({ error: 'Not a singing stream. Add ?force=true to override.' }, 400)
    }

    const formattedStream = {
      id: stream.streamID,
      title: stream.title,
      time: stream.time,
      category: categories
    }

    // force 同時跳過解析時機檢查（cooldown）與防線（熔斷/無戳）——手動觸發是「已人工確認留言正確」，
    // 也是防線誤擋時的救援通道
    const parseResult = await dataProcessor.parseSetlistForStream(formattedStream, c.env, { bypassCooldown: force, bypassGuards: force })

    if (parseResult && parseResult.items && parseResult.items.length > 0) {
      await dataProcessor.batchCreateSetlist(parseResult.items, c.env)
      await dataProcessor.updateStreamSetlistComplete(streamID, true, c.env)

      /* MIGRATED to yt-setlist-discord (2026-05-02): sendSetlistComment removed
      // 發送歌單留言到 Discord
      const setlistWebhookUrl = getSecret(c.env, 'DISCORD_SETLIST_WEBHOOK_URL')
      if (setlistWebhookUrl) {
        sendSetlistComment(setlistWebhookUrl, formattedStream, parseResult.setlistComment, parseResult.commentAuthor)
          .catch(() => {})
      }
      */

      await sendDiscordNotification(c.env, {
        type: 'manual-parse',
        success: true,
        streamID,
        title: stream.title,
        songCount: parseResult.items.length,
        skippedLines: parseResult.skippedLines?.length ? parseResult.skippedLines : undefined
      })

      return c.json({ success: true, streamID, songCount: parseResult.items.length, items: parseResult.items })
    }

    if (parseResult?.blocked) {
      return c.json({
        success: false,
        message: `防線攔截: ${parseResult.blocked.reason}（留言 by ${parseResult.blocked.commentAuthor || '?'}）。確認留言正確後可加 force=true 重試`
      })
    }

    return c.json({ success: false, message: '未找到歌單留言' })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

/* ============================================================
 * MIGRATED to yt-setlist-discord stack (2026-05-02)
 * /trigger-setlist-notify — 手動把 setlist 抓 YouTube 留言貼到 Discord
 * 已由 yt-setlist-discord 接管
 * ============================================================
// Send setlist notification independently (without re-parsing)
app.get('/trigger-setlist-notify', async (c) => {
  if (!validateTriggerToken(c)) return c.json({ error: 'Forbidden' }, 403)
  const streamID = c.req.query('streamID')
  const startDate = c.req.query('startDate')
  const endDate = c.req.query('endDate')

  if (!streamID && !startDate) {
    return c.json({ error: 'Missing streamID or startDate' }, 400)
  }

  const webhookUrl = getSecret(c.env, 'DISCORD_SETLIST_WEBHOOK_URL')
  if (!webhookUrl) {
    return c.json({ error: 'DISCORD_SETLIST_WEBHOOK_URL not configured' }, 500)
  }

  try {
    const db = c.get('db')
    let setlist

    if (streamID) {
      setlist = await db.query(
        'SELECT * FROM setlist WHERE streamID = ? ORDER BY segmentNo ASC, trackNo ASC',
        [streamID]
      )
    } else {
      const end = endDate || startDate
      setlist = await db.query(
        'SELECT * FROM setlist WHERE time >= ? AND time < DATE_ADD(?, INTERVAL 1 DAY) ORDER BY time ASC, segmentNo ASC, trackNo ASC',
        [startDate, end]
      )
    }

    if (!setlist || setlist.length === 0) {
      return c.json({ success: false, message: 'No setlist found' })
    }

    // Group by streamID
    const grouped = {}
    for (const row of setlist) {
      if (!grouped[row.streamID]) grouped[row.streamID] = { rows: [], time: row.time }
      grouped[row.streamID].rows.push(row)
    }

    // Fetch YouTube comments for each stream and send
    const { DataProcessor } = await import('./utils/data-processor.js')
    const dp = new DataProcessor()
    const apiKey = getSecret(c.env, 'YOUTUBE_API_KEY')
    let sentCount = 0
    const errors = []
    for (const [sid, data] of Object.entries(grouped)) {
      const stream = { id: sid, title: data.rows[0].streamTitle || '', time: data.time }
      try {
        // Try to get original YouTube comment
        const comments = await getVideoComments(sid, apiKey)
        const commentResult = dp.findSetlistComment(comments)
        if (commentResult) {
          await sendSetlistComment(webhookUrl, stream, commentResult.text, commentResult.author)
          sentCount++
        } else {
          errors.push({ streamID: sid, error: 'No setlist comment found on YouTube' })
        }
      } catch (err) {
        console.error(`[trigger-setlist-notify] Error for ${sid}:`, err)
        errors.push({ streamID: sid, error: err.message })
      }
    }

    return c.json({ success: true, sentCount, ...(errors.length > 0 && { errors }) })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})
============================================================ */

// Manual wiki verification
// ?lookbackDays=30  回溯天數（預設 30）
// ?date=2026/03/18  指定日期（JST）
// ?streamID=xxx     指定 streamID
app.get('/trigger-wiki-verify', async (c) => {
  if (!validateTriggerToken(c)) return c.json({ error: 'Forbidden' }, 403)

  const lookbackDays = parseInt(c.req.query('lookbackDays') || '30', 10)
  if (Number.isNaN(lookbackDays) || lookbackDays < 1 || lookbackDays > 365) {
    return c.json({ error: 'lookbackDays must be an integer between 1 and 365' }, 400)
  }
  const date = c.req.query('date')
  const streamID = c.req.query('streamID')

  try {
    const { verifyRecentSetlists, sendWikiDiffNotification } = await import('./utils/wiki-verifier.js')
    const result = await verifyRecentSetlists(c.env, { lookbackDays, date, streamID })

    if (result.mismatches > 0) {
      await sendWikiDiffNotification(c.env, result.details)
    }

    return c.json({ success: true, ...result })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Health check
app.get('/health', async (c) => {
  const db = c.get('db')
  const isConnected = await db.testConnection()
  return c.json({
    status: isConnected ? 'ok' : 'error',
    database: isConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
    service: 'Berry Site API'
  })
})

// Root
app.get('/', (c) => {
  return c.json({
    message: 'Berry Site API v3',
    endpoints: [
      'GET /api/songlist', 'GET /api/streamlist', 'GET /api/setlist',
      'GET /api/aliases', 'GET /api/yt?id={videoId}', 'GET /api/yt/newvideos',
      'POST /api/parse-setlist', 'GET /health'
    ]
  })
})

// ─── Cron Handler ───

export async function handleCronTrigger(event, env) {
  const now = new Date()
  const utcHour = now.getUTCHours()

  try {
    const { runAutoUpdate, runPollingCheck } = await import('./cron-jobs/auto-update.js')

    if (utcHour === 7) {
      // UTC 07:00 = Taiwan 15:00 - daily auto-update
      console.log('Cron: daily runAutoUpdate')
      await runAutoUpdate(env, 'recent', {}, 'CRON')
    } else if (utcHour >= 14 && utcHour <= 19) {
      // UTC 14:00~19:00 = Taiwan 22:00~03:00 - polling check
      console.log('Cron: runPollingCheck')
      await runPollingCheck(env)
    }
  } catch (error) {
    console.error('Cron error:', error)
    await sendDiscordNotification(env, {
      type: 'auto-update',
      result: { errors: [error.message] },
      success: false
    }).catch(() => {})
  }
}

export default app
