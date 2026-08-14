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

// 註：這裡曾有 `app.options('*', (c) => c.text('', 204))`——死碼，已移除。
// hono/cors 的中介層自己處理 preflight（method === 'OPTIONS' 時直接回 204 並帶齊
// Access-Control-* header，不呼叫 next），OPTIONS 請求永遠到不了下游 handler。

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

// API 回應的快取預設：沒有明示 Cache-Control 的 /api/* 回應補 `no-store`。
// 目的是關掉「無快取指示時由瀏覽器／中介 proxy 自行啟發式快取」這個灰色地帶
// （寫入回應、錯誤回應、/api/yt* 等即時查詢都屬於這類）。
// ⚠️ 只在「沒有」Cache-Control 時才補，絕不覆寫既有值——
//   · 304 路徑的 CACHE_CONFIG.HEADERS.NOT_MODIFIED（`public, max-age=0, must-revalidate`）
//   · 表格 GET 的 CACHEABLE（同上）——它們靠條件請求＋ETag 走 304 短路，
//     一旦被改成 no-store，客戶端不再儲存回應⇒ If-None-Match 消失⇒ 整套 meta ETag 失效。
app.use('/api/*', async (c, next) => {
  await next()
  if (!c.res.headers.get('Cache-Control')) {
    c.header('Cache-Control', 'no-store')
  }
})

// Rate limiting (in-memory, resets on cold start)
const rateLimits = new Map()
const RATE_WINDOW = 60_000 // 1 minute
// Map 容量上限：key 是 `${ip}:${tier}`，來源 IP 由請求方決定 ⇒ 大量不同 IP（或殭屍網路）
// 會讓這張表無上限成長，直到 isolate/容器 OOM。超限就整體 clear：最壞情況是所有人的
// 計數在那一刻歸零（限流短暫放寬一個視窗），比記憶體耗盡整個 Worker/Lambda 掛掉好。
const RATE_MAP_MAX = 10_000
// cleanup 節流：原本每個請求都全掃一遍 Map（O(n) on the hot path），表大時是白花的 CPU。
// 30 秒一次足夠——過期 entry 多留一會兒只佔記憶體，且容量上限已兜住最壞情況。
const RATE_CLEANUP_INTERVAL = 30_000
let lastRateCleanup = 0

function getRateKey(ip, tier) {
  return `${ip}:${tier}`
}

function cleanupRateLimits(now) {
  if (now - lastRateCleanup < RATE_CLEANUP_INTERVAL) return
  lastRateCleanup = now
  for (const [key, entry] of rateLimits) {
    if (now - entry.start > RATE_WINDOW * 2) rateLimits.delete(key)
  }
}

function checkRateLimit(ip, tier, maxRequests) {
  const key = getRateKey(ip, tier)
  const now = Date.now()
  let entry = rateLimits.get(key)

  if (!entry || now - entry.start > RATE_WINDOW) {
    // 只在「要新增 key」時檢查容量（既有 key 的續用不會讓表變大）
    if (!entry && rateLimits.size >= RATE_MAP_MAX) {
      console.warn(`[RATELIMIT] map size ${rateLimits.size} >= ${RATE_MAP_MAX}, clearing all counters`)
      rateLimits.clear()
    }
    entry = { start: now, count: 0 }
    rateLimits.set(key, entry)
  }

  entry.count++
  return entry.count <= maxRequests
}

// 限流用的 client IP。**限流 key 若可被請求方控制，整條限流形同虛設**，故取值一律
// 只信「該鏈路上由平台自己填、client 覆寫不了」的欄位。
//
// ── 信任模型（輸入 × 鏈路 × 誰說了算）─────────────────────────────────────────
//
// A) `cf-connecting-ip`
//    · CF 備用站（viewer → Cloudflare → Worker）：Cloudflare 邊緣**覆寫**填入，
//      viewer 送同名 header 會被蓋掉 ⇒ 可信。
//    · AWS 主站（viewer → CloudFront → API Gateway HTTP v2 → Lambda）：
//      **viewer 完全可控** —— /api/* 等 behavior 用 AllViewerExceptHostHeader origin
//      request policy，viewer 的 header 原樣轉發給 origin，而 CloudFront 不認識、
//      也不會覆寫這個 Cloudflare 專有 header。採信它＝每個請求自帶一個假 IP 就換到
//      一把新 rate key ⇒ **限流 100% 可繞過**（2026-08 深檢發現；舊註解說它
//      「外部不可偽造」只在 CF 側成立）。
//    ⇒ 修法：**只在非 Lambda 鏈路採信**。判準＝`c.env.requestContext.http.sourceIp`
//      是否存在：hono/aws-lambda adapter 把 `{event, requestContext, lambdaContext}`
//      當 env 傳進 app.fetch，該值在 Lambda 上恆存在；CF Workers 的 env 是 bindings，
//      必不存在（wrangler dev 亦同）⇒ 判準本身不可被請求方影響。
//
// B) `x-forwarded-for` **首段**：兩條鏈路都是 viewer 自帶的原值（CloudFront 保留在首段）
//    ⇒ 完全可控，**任何情況都不可採用**（每次換一個偽造首段就是一把新 rate key）。
//
// C) `x-forwarded-for` **倒數第二段**：只在 AWS 主站、且下述兩道把關都通過時＝訪客真實 IP
//    （見下方「為何需要第 2 層」與「形狀自檢」）。CF 側不適用。
//
// D) `x-forwarded-for` **末段**：主站上是 API Gateway append 的直連來源（＝CloudFront
//    edge）；本地/SAM local 沒有前面兩層時當兜底用。
//
// E) `requestContext.http.sourceIp`：API Gateway 填入，client 不可偽造 ⇒ 可信；
//    但主站上它是 **CloudFront edge 的 IP**（不是訪客 IP），故只當保守 fallback。
//    CF Workers／內部 app.request() 上不存在。
//
// F) `x-origin-verify`：CloudFront 的 origin custom header（值來自 CFN 參數），
//    viewer 送同名 header 會被 CloudFront **覆寫** ⇒ 可用來證明「這個請求真的經過
//    我們的 CloudFront」。CF 側／直打 execute-api 時不存在。
//
// G) 內部調用（cron 的 `app.request()`）：A~F 全部不存在 ⇒ 走到 'unknown'。
//    限流中介層對這種請求直接豁免（見下方 isInternalRequest）。
//
// ─────────────────────────────────────────────────────────────────────────────
//
// 為何需要 C 這一層：主站鏈路是 CloudFront → API Gateway (HTTP API v2) → Lambda，
// sourceIp 是 **CloudFront edge 的 IP** 而非訪客 IP ⇒ 全站寫入擠進極少數 rate key，
// 任何一人 30 寫入/分就能讓所有編輯者一起吃 429（2026-08 審查發現的副作用）。
// 訪客真實 IP 在 XFF 的倒數第二段，因為這條鏈路上有兩次自動 append：
//   CloudFront 對 custom origin 必定把 viewer IP append 到 XFF 尾端（hop header 由
//   CloudFront 自管，與 origin request policy 無關）→ API Gateway 再 append 它的直連
//   來源（＝CloudFront edge）⇒ `<viewer 自帶的任意值…>, <viewer 真實 IP>, <CF edge IP>`
//
// 為何要 secret 把關：「倒數第二段可信」只在請求**確定經過 CloudFront** 時成立——
// 直打 execute-api 端點的人可以自帶任意 XFF，倒數第二段就變成他說了算。故由 CloudFront
// 的 origin custom header `X-Origin-Verify`（值來自 CFN 參數，viewer 送同名 header 會被
// CloudFront 覆寫，偽造不了）證明鏈路，對不上就不採信 XFF。
// 直打時 fallback 到 sourceIp 是正確的：那條路徑上 sourceIp 就是攻擊者的真實 IP。
// secret 未配置（參數留白）時整段停用，行為與導入前完全相同 ⇒ 可安全先部署程式碼。
//
// ⚠️ 形狀自檢（fail-safe，2026-08 複審補上）：採信倒數第二段之前，先要求
//    **XFF 末段 === requestContext.http.sourceIp**。理由是「API Gateway 會 append 直連
//    來源」這件事未經實測，兩種可能各自的行為必須都安全：
//      H1「APIGW 有 append」——末段就是它填的直連來源（＝CloudFront edge＝sourceIp），
//         這個等式恆成立、零成本，倒數第二段照樣是 viewer 真實 IP。
//      H2「APIGW 原樣轉送 CloudFront 的 XFF」——末段是 CloudFront append 的 viewer IP，
//         與 sourceIp（CF edge）不相等 ⇒ 自檢必假、退回 sourceIp。此時全站寫入共用一把
//         key（保守、可能誤傷彼此），但攻擊者無法藉自帶 XFF 讓「倒數第二段」變成自己控制
//         的字串來換 key ⇒ 限流不可繞過。**不安全的失敗模式被這道等式擋掉。**
//    （sourceIp 缺席時等式必假，同樣落到保守分支。）
//
// ⚠️ 任何情況都不可取 XFF **首段**：CloudFront 保留 viewer 自帶的 XFF 值於首段，
//    每次請求換一個偽造首段就是一把新 rate key，30/min 上限會被完全繞過。
function getRateLimitIp(c) {
  // Lambda 判準（見上方 A）：這個值存在 ⇔ 請求走 hono/aws-lambda adapter 進來
  const sourceIp = c.env?.requestContext?.http?.sourceIp
  const isLambda = !!sourceIp
  const xff = c.req.header('x-forwarded-for')

  // cf-connecting-ip 只在非 Lambda 鏈路採信（Lambda 側該 header 由 viewer 說了算）
  if (!isLambda) {
    const cfIp = c.req.header('cf-connecting-ip')
    if (cfIp) return cfIp
  }

  // 經 CloudFront 驗證的鏈路才採信 XFF 倒數第二段（secret 值只做等長 constant-time
  // 比較，不寫進任何 log）。非 Lambda 鏈路沒有這組 header，也沒有 XFF 兩次 append 的
  // 形狀前提，整段跳過。
  if (isLambda && xff) {
    const originSecret = getSecret(c.env, 'ORIGIN_VERIFY_SECRET')
    if (originSecret && timingSafeEqualStr(c.req.header('x-origin-verify') || '', originSecret)) {
      const chain = xff.split(',')
      // 段數 < 2＝鏈路與預期不符（少一次 append），寧可退回 sourceIp 也不猜；
      // 末段 !== sourceIp＝鏈路形狀與 H1 不符（見上方自檢說明），同樣退回
      if (chain.length >= 2 && chain[chain.length - 1].trim() === sourceIp) {
        const viewerIp = chain[chain.length - 2].trim()
        if (viewerIp) return viewerIp
      }
    }
  }

  return sourceIp
    || xff?.split(',').pop()?.trim()
    || 'unknown'
}

// ── 限流覆蓋範圍 ──
// 每分鐘上限（per IP per tier）。原本只掛 '/api/*' 且只算寫入方法 ⇒ /health（每次都
// 開連線 ping DB）與 /trigger-*（token 錯了也會被無限次嘗試、且每次都跑 DB 查詢）
// 完全沒有上限（2026-08 深檢）。現改為單一 '*' 中介層依路徑分 tier：
const RATE_TIERS = {
  expensive: 5,   // /api/parse-setlist：呼叫 matcher Lambda ＋寫 songlist/setlist
  trigger: 10,    // /trigger-*：手動觸發（token 保護，但錯誤嘗試本身也要限速）
  health: 30,     // /health：每次都做一次 DB 連線測試
  write: 30,      // /api/* 的寫入方法（原有行為）
}

/**
 * 依路徑／方法決定 tier；null ＝ 不限流。
 * ⚠️ /webhook/* 刻意不納入：PubSub hub 的通知已由 HMAC 簽名把關，限流反而可能
 *    丟掉真通知（hub 重試有限）。
 */
function resolveRateTier(path, method) {
  // 原本的 includes('/parse-setlist') 語意保留（實際路徑為 /api/parse-setlist；
  // 注意 /trigger-setlist-parse 字面不同、不會誤入這個 tier）
  if (path.includes('/parse-setlist')) return 'expensive'
  if (path.startsWith('/trigger-')) return 'trigger'
  if (path === '/health') return 'health'
  if (path.startsWith('/api/')) {
    // 讀取方法不限流（GET 全量表格是正常瀏覽行為，且 304 路徑成本極低）
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
    return 'write'
  }
  return null
}

/**
 * 內部調用（cron 的 `app.request()`）豁免：正式環境的兩條鏈路一定帶得出來源
 * （Lambda＝requestContext.http.sourceIp；CF＝cf-connecting-ip），三者全無＝
 * 不是外部請求（app.request()／本地 node／SAM local）。
 * 目前 snapshot cron 只打 GET /api/*（本來就不入 tier），這層是防它日後改用寫入端點
 * 或 /health 時被自己的限流擋住。
 */
function isInternalRequest(c) {
  return !c.env?.requestContext?.http?.sourceIp &&
    !c.req.header('cf-connecting-ip') &&
    !c.req.header('x-forwarded-for')
}

app.use('*', async (c, next) => {
  const tier = resolveRateTier(c.req.path, c.req.method)
  if (!tier) return next()
  if (isInternalRequest(c)) return next()

  cleanupRateLimits(Date.now())

  const ip = getRateLimitIp(c)
  if (!checkRateLimit(ip, tier, RATE_TIERS[tier])) {
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
    // 原本回 `details: error.message`——把 DB／內部錯誤原文吐給呼叫端。
    // 改為 rethrow 交給 app.onError：dev/test 才附真實訊息，正式環境泛化（分流集中一處）
    console.error('Parse setlist error:', error)
    throw error
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

// PubSub topic 的唯一合法形狀（renewPubSubSubscription 與手動 curl 註冊的都是這個字串）
const PUBSUB_TOPIC_PREFIX = 'https://www.youtube.com/xml/feeds/videos.xml?channel_id='

// PubSubHubbub webhook
app.get('/webhook/youtube', (c) => {
  // Subscription verification：驗證 hub.mode 與 hub.topic，
  // 否則任何人可向 hub 發起 unsubscribe，本端點無條件 echo challenge 等於替對方確認注銷
  const challenge = c.req.query('hub.challenge')
  if (challenge) {
    const mode = c.req.query('hub.mode')
    const topic = c.req.query('hub.topic') || ''
    // ⚠️ 舊寫法 `topic.includes('channel_id=' + ch)` 是子字串比對：
    //   `https://attacker.example/?x=channel_id=UC7A7...` 也能通過 ⇒ 我們會替任意
    //   topic 的訂閱／注銷確認 challenge。改為「前綴是 YouTube feed URL、且其後
    //   剩下的部分恰好等於白名單頻道 ID」（＝完整 URL 相等，同時滿足
    //   startsWith(prefix) ∧ endsWith(ch)，並額外排掉中間夾雜參數的變形）。
    const isOurChannel = topic.startsWith(PUBSUB_TOPIC_PREFIX) &&
      CONFIG.berryChannels.some(ch => topic.slice(PUBSUB_TOPIC_PREFIX.length) === ch)
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
  // 簽名驗證（hub.secret = TRIGGER_TOKEN）：2026-06-13 起所有訂閱已帶 secret
  //（手動重訂閱完成＋renewPubSubSubscription 自動續訂亦帶），無簽名＝偽造來源，一律拒絕。
  // ⚠️ header 的存在與形狀先驗、**確認後才讀 body**：這個端點對外開放（CloudFront
  //   /webhook/* 直通 API Gateway），先 await c.req.text() 等於讓任何人都能把任意大小的
  //   body 灌進 Lambda 記憶體才被拒絕。形狀＝`sha1=` ＋ 40 個 hex（HMAC-SHA1 hex 長度）。
  const signature = c.req.header('X-Hub-Signature')
  if (!signature || !/^sha1=[0-9a-fA-F]{40}$/.test(signature)) {
    console.warn('[PUBSUB] 拒絕無簽名／簽名格式不符的通知（訂閱已全面帶 hub.secret）')
    return c.text('OK', 200) // 回 200 避免 hub 重試轟炸，但不處理
  }
  const secret = getSecret(c.env, 'TRIGGER_TOKEN')
  // 無 secret 時無從驗證來源，一律不處理（fail-closed）；三個部署環境皆已設定此變數
  if (!secret) {
    console.error('[PUBSUB] TRIGGER_TOKEN 未設定，無法驗證簽名，不處理此通知')
    return c.text('OK', 200) // 與上方分支同策略：回 200 避免 hub 重試轟炸
  }

  const body = await c.req.text()
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
    // 不回 error.message 原文（可能含 DB／內部細節）——交給 app.onError 分流
    console.error('Trigger update failed:', error)
    throw error
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
    // ⚠️ 原本是 `!!c.req.query('force')`——只要參數存在就成立，`?force=false`／`?force=0`
    //   同樣為 true，等於一路關掉 cooldown 與熔斷／無戳防線（bypassGuards 見下）。
    //   只認明示的 true／1。
    const force = ['true', '1'].includes(c.req.query('force'))
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
    // 不回 error.message 原文——交給 app.onError（dev/test 才附真因）
    console.error(`Trigger setlist parse failed (streamID=${streamID}):`, error)
    throw error
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
    // 不回 error.message 原文——交給 app.onError（dev/test 才附真因）
    console.error('Trigger wiki verify failed:', error)
    throw error
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
    } else {
      // 排程被觸發卻沒有對應工作＝EventBridge 規則與這裡的小時分派不一致
      // （改過 template.yaml 的 cron 卻忘了改這裡）。靜默 return 會讓它看起來一切正常。
      console.warn(`Cron: 無對應工作的觸發時段 utcHour=${utcHour}（EventBridge 規則與分派邏輯不一致？）`)
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
