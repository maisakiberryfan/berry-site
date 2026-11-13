/**
 * Node 正式入口——在一台一般主機（VPS）上，用單一 Node 程序跑整個站。
 * 建議搭配 repo 根的 Dockerfile＋docker-compose.yml 使用（步驟見 docs/HANDOVER.md 路線 A）。
 *
 * 與另外兩個入口的關係：
 *   entry-lambda.js  AWS（靜態檔在 S3＋CloudFront，這裡只有 API）
 *   entry-worker.js  Cloudflare（靜態檔是 Workers Static Assets）
 *   entry-node.js    本檔。**直接重用 entry-worker.js 的 fetch**，只是把它需要的
 *                    `env.ASSETS` 換成「從本機磁碟讀檔」——惡意路徑阻擋、SPA 路由白名單、
 *                    分享預覽（OG）快照、/tb 縮圖轉址、安全標頭都是同一份程式，
 *                    不另抄一份清單。
 *   entry-dev.js     本機開發用（錯誤訊息不隱藏細節、沒有排程），不要拿來當正式環境。
 *
 * 另外補上雲端平台原本代勞的三件事：
 *   排程      每分鐘對時的小排程器（時間表在 src/node-runtime.js，抄自 template.yaml）
 *   歌單比對  lambda/setlist-matcher 的 handler 直接掛在本程序的內部路徑
 *   快照      /data/*.json 由排程呼叫 fansite-v2/scripts/fetch-snapshot.mjs 重產
 *
 * 不用 Docker 直接跑（Node 20.6+；先 build 前端、裝好 matcher 的依賴）：
 *   npm ci && (cd lambda/setlist-matcher && npm ci) && (cd fansite-v2 && npm ci && npm run build)
 *   node --env-file=.env entry-node.js
 *
 * 會讀的環境變數（DB_* 與各 API 金鑰之外；範例見 .env.example）：
 *   PORT / HOST         預設 8080 / 127.0.0.1（預期前面有反向代理做 TLS）
 *   TRUSTED_PROXIES     反向代理不在本機時（例如另一個容器）要設：逗號分隔的 IPv4 位址或 CIDR。
 *                       對端在清單內才採信它附加的 X-Forwarded-For；沒設而代理又不在本機，
 *                       所有訪客會被算成同一個 IP（限流變成全站共用）
 *   DB_SSL=false        資料庫在同一台（或同一組容器）、沒開 TLS 時關掉 TLS 連線
 *   CRON_DISABLED=1     不啟動內建排程
 *   LAMBDA_MATCHER_URL  已設＝使用外部的比對服務，不掛內建的那一份
 */
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { dueJobs, isLoopback, parseTrustedProxies, resolveClientIp } from './src/node-runtime.js'

// cwd 錨定到本檔所在目錄：serveStatic 的相對路徑以 process.cwd() 解析
process.chdir(dirname(fileURLToPath(import.meta.url)))

const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '127.0.0.1'
const SELF = `http://127.0.0.1:${PORT}`
const MATCHER_PATH = '/internal/match-setlist'
const TRUSTED = parseTrustedProxies(process.env.TRUSTED_PROXIES)   // 格式錯誤會在這裡拋錯、啟動失敗

if (!existsSync('./fansite-v2/dist/index.html')) {
  console.error('[entry-node] 找不到 fansite-v2/dist/index.html——先執行：cd fansite-v2 && npm ci && npm run build')
  process.exit(1)
}

// ── 歌單比對：掛在本程序內 ───────────────────────────────────────────────────
// 這三個值必須在 import 後端與 matcher **之前**就位（matcher 在模組頂層讀 BERRY_SITE_API_URL）。
// 密鑰沒設就自動產生一個只活在這個程序裡的隨機值：內部路徑雖然和網站同一個埠，
// 外面沒有密鑰一樣叫不動它。
const useEmbeddedMatcher = !process.env.LAMBDA_MATCHER_URL
let matcherHandler = null
if (useEmbeddedMatcher) {
  process.env.LAMBDA_MATCHER_URL = `${SELF}${MATCHER_PATH}`
  process.env.BERRY_SITE_API_URL ||= SELF
  process.env.MATCHER_SHARED_SECRET ||= randomBytes(32).toString('hex')
  try {
    ({ handler: matcherHandler } = await import('./lambda/setlist-matcher/src/handler.js'))
  } catch (err) {
    console.warn(`[entry-node] 內建歌單比對載入失敗，歌單自動解析將無法使用：${err.message}`)
    console.warn('[entry-node] 多半是還沒裝依賴：(cd lambda/setlist-matcher && npm ci)')
  }
}

const { default: worker } = await import('./entry-worker.js')
const { handleCronTrigger } = await import('./src/app.js')

// ── 靜態檔：取代 Workers 的 ASSETS binding ───────────────────────────────────
const cache = (value) => (_path, c) => { c.header('Cache-Control', value) }
const assets = new Hono()
// 年表與首頁「最近更新」直接讀 repo 內的原始檔：改完存檔就生效，不必重新 build。
// 兩組路徑都要給——/data/ 是前端讀的位置，另一組是快照腳本抓的原位（同 AWS 主站）
for (const p of ['/data/history.md', '/pages/history.md']) {
  // serveStatic 的 MIME 表不認得 .md（會給 application/octet-stream），自己補上
  assets.get(p, async (c, next) => {
    await next()
    if (c.res.ok) c.res.headers.set('Content-Type', 'text/markdown; charset=utf-8')
  }, serveStatic({ path: './fansite/pages/history.md', onFound: cache('public, max-age=300') }))
}
for (const p of ['/data/changelog.json', '/changelog.json']) {
  assets.get(p, serveStatic({ path: './fansite/changelog.json', onFound: cache('public, max-age=300') }))
}
// 資料快照：排程重產到 public/data/（不必重新 build）；沒有才退回 build 當時複製進 dist 的那份
assets.use('/data/*', serveStatic({ root: './fansite-v2/public', onFound: cache('public, max-age=300') }))
assets.use('/img/*', serveStatic({ root: './fansite', onFound: cache('public, max-age=86400') }))
// Vite 的 hash 檔名：內容變＝檔名變，可以永久快取
assets.use('/assets/*', serveStatic({ root: './fansite-v2/dist', onFound: cache('public, max-age=31536000, immutable') }))
assets.use('*', serveStatic({ root: './fansite-v2/dist', onFound: cache('no-cache') }))

// Workers 的 ctx.waitUntil：回應送出後繼續跑的背景工作（YouTube 通知的後續處理用它）。
// 常駐程序不需要「延長生命週期」，只要確保 rejection 不會變成未處理例外
const ctx = {
  waitUntil(promise) { Promise.resolve(promise).catch((err) => console.error('[entry-node] 背景工作失敗：', err)) },
  passThroughOnException() {}
}

async function handle(request, incoming) {
  const url = new URL(request.url)
  const remote = incoming?.socket?.remoteAddress || ''
  const xff = incoming?.headers?.['x-forwarded-for']

  // 內建歌單比對：只接受本程序自己發起的請求（對端是 loopback、而且沒經過任何代理），
  // 再加上 handler 自己的密鑰驗證
  if (url.pathname === MATCHER_PATH) {
    if (!matcherHandler || !isLoopback(remote) || xff) return new Response('', { status: 404 })
    const res = await matcherHandler({
      httpMethod: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text()
    })
    // headers 一定要複製：handler 每次都回傳**同一個**共用的 headers 物件，直接交出去的話
    // 伺服器層會把這次算出的 Content-Length 寫回那個物件，下一個回應就帶著上一次的長度被截斷
    // （2026-11-13 實測：先回一次 401，之後的 200 全被截成 401 的長度）
    return new Response(res.body, { status: res.statusCode, headers: { ...res.headers } })
  }

  // 後端的限流以 `env.requestContext.http.sourceIp` 為可信來源（Lambda 上由 API Gateway 填）。
  // 這裡照同一個形狀填，後端就不會去採信訪客自己送的 cf-connecting-ip／X-Forwarded-For
  const env = {
    ASSETS: { fetch: (req) => assets.fetch(req) },
    requestContext: { http: { sourceIp: resolveClientIp(remote, xff, TRUSTED) } }
  }
  return worker.fetch(request, env, ctx)
}

// ── 排程 ─────────────────────────────────────────────────────────────────────
function runSnapshot() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['fansite-v2/scripts/fetch-snapshot.mjs'], {
      env: { ...process.env, BERRY_API: SELF, BERRY_STATIC: SELF },
      stdio: 'inherit'
    })
    child.on('exit', (code) => { if (code !== 0) console.warn(`[cron] 快照腳本結束碼 ${code}`); resolve() })
    child.on('error', (err) => { console.error('[cron] 快照腳本啟動失敗：', err); resolve() })
  })
}

const RUNNERS = {
  daily: () => handleCronTrigger({ source: 'cron', job: 'daily' }, {}),
  polling: () => handleCronTrigger({ source: 'cron', job: 'polling' }, {}),
  snapshot: runSnapshot
}

const running = new Set()
let lastMinute = ''

function start(name) {
  if (running.has(name)) { console.warn(`[cron] ${name} 上一輪還沒結束，這一輪跳過`); return }
  running.add(name)
  console.log(`[cron] ${new Date().toISOString().slice(0, 16)}Z 開始 ${name}`)
  Promise.resolve().then(RUNNERS[name])
    .catch((err) => console.error(`[cron] ${name} 失敗：`, err))
    .finally(() => running.delete(name))
}

function tick() {
  const now = new Date()
  const minute = now.toISOString().slice(0, 16)
  if (minute === lastMinute) return
  lastMinute = minute
  for (const name of dueJobs(now)) start(name)
}

serve({ fetch: (request, bindings) => handle(request, bindings?.incoming), port: PORT, hostname: HOST }, () => {
  console.log(`[entry-node] http://${HOST}:${PORT}  DB=${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}` +
    `  歌單比對=${useEmbeddedMatcher ? (matcherHandler ? '內建' : '內建（載入失敗）') : '外部'}` +
    `  排程=${process.env.CRON_DISABLED === '1' ? '停用' : '啟用'}` +
    `  受信任的代理=${TRUSTED.length ? process.env.TRUSTED_PROXIES : '僅本機'}`)
})

if (process.env.CRON_DISABLED !== '1') {
  setInterval(tick, 20_000)
  // 第一次啟動還沒有資料快照時先產一份（前端沒有快照也能跑，只是首訪要多等 API）
  if (!existsSync('./fansite-v2/public/data/manifest.json')) setTimeout(() => start('snapshot'), 10_000)
}
