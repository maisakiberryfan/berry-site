/**
 * Berry Site - Unified Hono App
 * Consolidates Worker + Hyperdrive + YTID into a single platform-agnostic app
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { CONFIG } from './config.js'
import { Database } from './utils/database.js'
import { getSecret } from './platform.js'
import { extractVideoId } from './utils/url-helpers.js'
import { initLogger, getLogger } from './utils/unified-logger.js'
import { sendDiscordNotification } from './utils/discord-notifier.js'
import { getVideoComments } from './utils/youtube-comments.js'
import { errorHandler, mysqlToISO8601 } from './utils/middleware.js'
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
  getSetlist, createSetlistEntry, updateSetlistEntry, deleteSetlistEntry
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

app.use('*', errorHandler)

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
api.get('/setlist', getSetlist)
api.post('/setlist', createSetlistEntry)
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
    return c.json({ success: false, error: error.message }, 500)
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
    return c.json({ error: '無法獲取影片資訊', details: error.message }, 500)
  }
})

// Latest video (from streamlist DB)
api.get('/yt/latest', async (c) => {
  try {
    const db = c.get('db')
    const rows = await db.query(
      'SELECT streamID, title, time, categories FROM streamlist ORDER BY time DESC LIMIT 1'
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
    return c.json({ error: '無法獲取最新影片', details: error.message }, 500)
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
    return c.json({ error: '無法獲取新影片資訊', details: error.message }, 500)
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
    return c.json({ error: 'Failed to get live details', details: error.message }, 500)
  }
})

// Parse setlist
api.post('/parse-setlist', async (c) => {
  const workerLogger = initLogger(c.env)
  workerLogger.startRequest()

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

    if (!setlistResult || setlistResult.length === 0) {
      return c.json({ error: '未找到歌單', videoId }, 404)
    }

    return c.json({
      success: true,
      videoId,
      songCount: setlistResult.length,
      songIDs: setlistResult.map(item => item.songID),
      setlistItems: setlistResult
    })
  } catch (error) {
    console.error('Parse setlist error:', error)
    return c.json({ error: '歌單解析失敗', details: error.message }, 500)
  } finally {
    await workerLogger.endRequest()
  }
})

// Get comments
api.post('/get-comments', async (c) => {
  try {
    const { youtubeUrl } = await c.req.json()
    if (!youtubeUrl) return c.json({ error: 'YouTube URL 為必填項目' }, 400)

    const videoId = extractVideoId(youtubeUrl)
    if (!videoId) return c.json({ error: '無效的 YouTube URL' }, 400)

    const apiKey = getSecret(c.env, 'YOUTUBE_API_KEY') || getSecret(c.env, 'YOUTUBEAPIKEY')
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

// GitHub latest commit
let commitCache = { data: null, expiry: 0 }

api.get('/github/latest-commit', async (c) => {
  const now = Date.now()
  if (commitCache.data && now < commitCache.expiry) {
    return c.json(commitCache.data)
  }

  try {
    const githubToken = getSecret(c.env, 'GITHUB_TOKEN')
    const repoName = getSecret(c.env, 'GITHUB_REPO') || 'maisakiberryfan/berry-site'

    const res = await fetch(
      `https://api.github.com/repos/${repoName}/commits?per_page=1&path=fansite/`,
      {
        headers: {
          ...(githubToken ? { 'Authorization': `Bearer ${githubToken}` } : {}),
          'User-Agent': 'berry-worker',
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    )

    if (!res.ok) return c.json({ error: 'GitHub API error' }, 502)

    const data = await res.json()
    const result = {
      date: data[0]?.commit?.committer?.date,
      message: data[0]?.commit?.message
    }

    commitCache = { data: result, expiry: now + 5 * 60 * 1000 }
    return c.json(result)
  } catch (error) {
    return c.json({ error: 'Failed to fetch commit' }, 500)
  }
})

// AI Text-to-SQL
const AI_BUDGET_LIMIT = 0.1 // USD per day

const AI_WHITELIST = [
  '歌', '唱', '曲', '首', '音樂',
  '年', '月', '日', '時間', '最近', '最新',
  '最多', '最少', '前', '名', '排行', '排名', '統計',
  '幾次', '次數', '數量', '總共', '共',
  '列表', '清單', '歌單', '紀錄',
  '搜尋', '找', '查', '顯示', '列出',
  '類別', '分類', '歌枠', '雑談', 'asmr',
  '直播', '影片', '動畫', '遊戲',
  'song', 'artist', 'stream', 'setlist', 'track',
  'count', 'top', 'list', 'search', 'find',
  'year', 'month', 'genre', 'category'
]

const AI_BLACKLIST = [
  '你是誰', '你的名字', '你叫什麼', '什麼模型', '哪個模型', '顯示模型',
  '你的身份', '自我介紹', 'who are you', 'your name',
  '天氣', '你好', '謝謝', '早安', '晚安',
  '幫我寫', '寫一個', '寫程式', '寫代碼',
  '翻譯', '什麼意思'
]

const AI_SYSTEM_PROMPT = `Convert to DuckDB SQL. Output ONLY SQL, no markdown.

Table: berry_data
Columns: streamID, streamTitle, time(TIMESTAMP), categories, trackNo, songID, songName(主要), songNameEn, artist(主要), artistEn, genre, tieup

Rules:
- YEAR(time) for year, COUNT(*) for counting
- LIKE '%keyword%' for text search
- ROW_NUMBER() OVER (PARTITION BY x ORDER BY y DESC) as rn, WHERE rn <= N for top N per group
- LIMIT 100 max

Examples:
- 唱最多的歌 → SELECT songName,artist,COUNT(*)as c FROM berry_data GROUP BY songName,artist ORDER BY c DESC LIMIT 20
- 2024年歌單 → SELECT songName,artist,time FROM berry_data WHERE YEAR(time)=2024 ORDER BY time DESC
- 各年前10名 → SELECT year,songName,artist,c FROM(SELECT YEAR(time)as year,songName,artist,COUNT(*)as c,ROW_NUMBER()OVER(PARTITION BY YEAR(time)ORDER BY COUNT(*)DESC)as rn FROM berry_data GROUP BY YEAR(time),songName,artist)WHERE rn<=10 ORDER BY year DESC,c DESC
- 唱過幾次心做し → SELECT songName,artist,COUNT(*)as c FROM berry_data WHERE songName LIKE'%心做し%'GROUP BY songName,artist`

function validateAiInput(query) {
  const q = query.toLowerCase()
  if (query.length < 2) return { valid: false, error: '查詢太短' }
  if (query.length > 80) return { valid: false, error: '查詢太長（最多 80 字元）' }
  for (const keyword of AI_BLACKLIST) {
    if (q.includes(keyword.toLowerCase())) {
      return { valid: false, error: '此問題與歌單資料庫無關，請詢問歌曲相關問題' }
    }
  }
  const hasValidKeyword = AI_WHITELIST.some(k => q.includes(k.toLowerCase()))
  if (!hasValidKeyword) {
    return { valid: false, error: '請輸入與歌曲、歌單相關的查詢問題' }
  }
  return { valid: true }
}

api.post('/text-to-sql', async (c) => {
  const anthropicKey = getSecret(c.env, 'ANTHROPIC_API_KEY')
  if (!anthropicKey) return c.json({ error: 'AI service not configured' }, 503)

  try {
    const { query } = await c.req.json()
    if (!query || query.trim().length === 0) return c.json({ error: '請輸入查詢問題' }, 400)

    // Input validation (whitelist/blacklist)
    const validation = validateAiInput(query.trim())
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400)
    }

    // Budget check via DB
    const db = c.get('db')
    const dateKey = new Date().toISOString().slice(0, 10)

    // Ensure ai_usage table exists (first-time setup)
    try {
      await db.execute(`CREATE TABLE IF NOT EXISTS ai_usage (
        dateKey VARCHAR(10) PRIMARY KEY,
        cost DECIMAL(10,6) DEFAULT 0,
        count INT DEFAULT 0,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`)
    } catch { /* table already exists */ }

    const usage = await db.first('SELECT cost, count FROM ai_usage WHERE dateKey = ?', [dateKey])
    const todayCost = parseFloat(usage?.cost) || 0

    if (todayCost >= AI_BUDGET_LIMIT) {
      return c.json({ success: false, error: '今日 AI 額度已用完，請明天再試' }, 429)
    }

    // Call Claude Haiku with system prompt
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: AI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: query }]
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(errorData.error?.message || `API error: ${response.status}`)
    }

    const result = await response.json()
    let sql = result.content?.[0]?.text || ''
    sql = sql.replace(/```sql\n?/gi, '').replace(/```\n?/g, '').trim()

    if (!sql.toLowerCase().startsWith('select')) {
      return c.json({ success: false, error: '無法生成有效的 SQL 查詢', raw: sql })
    }

    // Calculate and record cost (Haiku 4.5: $1/MTok input, $5/MTok output)
    const inputTokens = result.usage?.input_tokens || 0
    const outputTokens = result.usage?.output_tokens || 0
    const cost = (inputTokens / 1_000_000) + (outputTokens / 1_000_000 * 5)

    await db.execute(
      `INSERT INTO ai_usage (dateKey, cost, count) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE cost = cost + VALUES(cost), count = count + 1`,
      [dateKey, cost]
    )

    return c.json({
      success: true,
      sql,
      query,
      usage: { inputTokens, outputTokens, cost: cost.toFixed(6), todayTotal: (todayCost + cost).toFixed(6) }
    })
  } catch (error) {
    console.error('AI text-to-sql error:', error)
    return c.json({ success: false, error: 'AI processing failed' }, 500)
  }
})

// PubSubHubbub webhook
app.get('/webhook/youtube', (c) => {
  // Subscription verification
  const challenge = c.req.query('hub.challenge')
  if (challenge) return c.text(challenge)
  return c.text('OK')
})

app.post('/webhook/youtube', async (c) => {
  const body = await c.req.text()

  // Parse Atom feed
  const videoIdMatch = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)
  const channelIdMatch = body.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)

  if (!videoIdMatch || !channelIdMatch) {
    return c.text('OK', 200)
  }

  const videoId = videoIdMatch[1]
  const channelId = channelIdMatch[1]

  // Validate target channel
  const targetChannels = ['UC7A7bGRVdIwo93nqnA3x-OQ', 'UCBOGwPeBtaPRU59j8jshdjQ', 'UC2cgr_UtYukapRUt404In-A']
  if (!targetChannels.includes(channelId)) {
    return c.text('OK', 200)
  }

  // Ignore delete notifications
  if (body.includes('at:deleted-entry')) {
    return c.text('OK', 200)
  }

  console.log(`PubSub notification: videoId=${videoId}, channelId=${channelId}`)

  // Background processing
  const bgWork = (async () => {
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
  })()

  // Platform-specific: CF uses waitUntil, Lambda just awaits
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(bgWork)
  } else {
    await bgWork
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
    return c.json({ error: error.message }, 500)
  }
})

// Mount all API routes under /api/
app.route('/api', api)

// ─── Infrastructure Routes (no /api/ prefix) ───

// Manual trigger
app.post('/trigger-update', async (c) => {
  const workerLogger = initLogger(c.env)
  workerLogger.startRequest()

  try {
    const body = await c.req.json().catch(() => ({}))
    const mode = body.mode || 'recent'

    const { runAutoUpdate } = await import('./cron-jobs/auto-update.js')
    const result = await runAutoUpdate(c.env, mode, {}, 'MANUAL')

    return c.json({ success: true, result })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  } finally {
    await workerLogger.endRequest()
  }
})

// Manual setlist parse
app.get('/trigger-setlist-parse', async (c) => {
  const streamID = c.req.query('streamID')
  if (!streamID) return c.json({ error: 'Missing streamID' }, 400)

  const workerLogger = initLogger(c.env)
  workerLogger.startRequest()

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
    if (!isSinging && !c.req.query('force')) {
      return c.json({ error: 'Not a singing stream. Add ?force=true to override.' }, 400)
    }

    const formattedStream = {
      id: stream.streamID,
      title: stream.title,
      time: stream.time,
      category: categories
    }

    const result = await dataProcessor.parseSetlistForStream(formattedStream, c.env)

    if (result && result.length > 0) {
      await dataProcessor.batchCreateSetlist(result, c.env)
      await dataProcessor.updateStreamSetlistComplete(streamID, true, c.env)

      await sendDiscordNotification(c.env, {
        type: 'manual-parse',
        success: true,
        streamID,
        title: stream.title,
        songCount: result.length
      })

      return c.json({ success: true, streamID, songCount: result.length, items: result })
    }

    return c.json({ success: false, message: '未找到歌單留言' })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  } finally {
    await workerLogger.endRequest()
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

  const workerLogger = initLogger(env)
  workerLogger.startRequest()

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
  } finally {
    await workerLogger.endRequest()
  }
}

export default app
