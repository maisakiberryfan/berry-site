/**
 * Cloudflare Worker entry point（備用站 www.m-b.win）
 * Handles: API routes (Hono) + Static Assets + SPA fallback
 *
 * Flow:
 * 1. 惡意掃描路徑 → 404（清單與 AWS 側的 BotBlockerFunction 對齊）
 * 2. /tb/{videoId}.jpg → 302 到 YouTube CDN（CF 側沒有縮圖 bucket）
 * 3. Try static assets first (CSS, JS, images, etc.)
 * 4. If not a static file, try Hono app (API routes)
 * 5. Hono 404 + client accepts HTML → SPA：白名單路由回 index.html(200)，
 *    其餘同樣送 index.html 的 body 但狀態碼 404
 */

import app, { handleCronTrigger } from './src/app.js'

// ── Security headers（靜態資源用）────────────────────────────────────────────
// 靜態檔案由 env.ASSETS.fetch() 直接回傳、完全不經過 Hono，所以 src/app.js 的
// header middleware 覆蓋不到——CF 站要讓 HTML 帶 CSP，唯一位置就是這裡。
//
// CSP 各 source 的依據（改前端資源來源時必須同步檢查 template.yaml 的同一份字串）。
// 以下位置為 **v3（fansite-v2/）現況**——2026-08-13 兩站內容切換 v3 後，2026-08-14 更新：
//   script-src  'wasm-unsafe-eval'        sql.js（SQLite/WASM）模組編譯。
//                                         src/lib/analytics/engine.js 以
//                                         `import 'sql.js/dist/sql-wasm.wasm?url'` self-host，
//                                         產物落在 /assets/（Vite hash 檔名）；三層 lazy，
//                                         按下「執行」才動態 import()
//   img-src     https://i.ytimg.com       縮圖 fallback（/tb/ 缺圖時）：
//                                         src/lib/home/HeroCard.svelte 與
//                                         src/lib/table/utils.js 的 ytThumbUrl()，
//                                         ＋本檔的 /tb/ 302（見 TB_PATH）
//               data:                     v2 遺留（bootstrap/select2 CSS 內的 data:image/svg+xml）。
//                                         v3 已無消費者（Tailwind 4 不產 data URI、圖示走內聯 SVG），
//                                         留著只為與 template.yaml 逐字一致——兩側要拿掉得一起拿
//   font-src    'self'                    v3 不載任何字型檔（bootstrap-icons 改 `?raw` 內聯 SVG，
//                                         內文為系統字型堆疊）；保留＝預設拒絕外部字型
//   media-src   'self'                    src/pages/Profile.svelte 的 BGM mp3（/img/profile/bgm/*.mp3）
//   style-src   'unsafe-inline'           Svelte 元件的動態 style=""（DataTable 欄寬、
//                                         ResultTable 表格寬、berry token 直寫），無法收斂成 class；
//                                         v3 已無 inline <style> 區塊
//   connect-src 'self'                    前端 fetch 只有同源 /api/*（client.js 的 BASE_URL 為空字串）
//                                         與 /data/*（CDN 快照、changelog、history.md）
//   script-src 刻意「不含」'unsafe-inline'：index.html 零 inline script，唯一的非 bundle
//   腳本是 public/theme-init.js（首繪前套主題防閃爍，獨立成檔），其餘全由
//   /assets/index-*.js 的 ESM 動態 import 拉起。
//
// 2026-08-09 收斂：Analytics 由 DuckDB-WASM＋parquet 改為 self-host 的 sql.js＋瀏覽器
// 既有快取，外部來源 cdn.jsdelivr.net（script-src/connect-src）與 sqldata.m-b.win
// （connect-src）全部移除；blob worker 也只有 DuckDB 用過，worker-src 收回 'self'。
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; font-src 'self'; connect-src 'self'; media-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  // 現代建議值：關閉舊版 XSS auditor（其自身曾是資訊洩漏來源），防護交給 CSP
  'X-XSS-Protection': '0'
}

// ── SPA 路由白名單 ───────────────────────────────────────────────────────────
// ⚠️ **白名單有四份，新增／改名路由必須四處一起改**（漏一處的症狀各不相同，
//    而且都只在部署後才看得出來）：
//   1. fansite-v2/src/router.svelte.js 的 ROUTES —— 站內連結清單的單一真相
//   2. fansite-v2/src/App.svelte 的 PAGES        —— 真正決定渲染哪個頁面元件
//   3. template.yaml BotBlockerFunction 的 spaRoutes —— AWS 主站（CloudFront Function）
//   4. 本檔的 SPA_ROUTES                          —— CF 備用站（本檔）
// 無法 import 共用：Workers bundle 只含 src/ 後端程式碼，fansite-v2 是 [assets] 靜態檔，
// 兩者不在同一個模組圖裡。硬編一份是刻意的取捨，靠這段註解與 router.svelte.js 檔頭
// 互相指認。清單一律小寫，比對前把路徑轉小寫（URL 路徑大小寫敏感）。
const SPA_ROUTES = new Set([
  '/',
  '/songlist',
  '/streamlist',
  '/setlist',
  '/aliases',
  '/analytics',
  '/profile',
  '/history',
  '/clothes',
  '/discography'
])

// ── 惡意掃描路徑 ─────────────────────────────────────────────────────────────
// AWS 側由 CloudFront Function（template.yaml 的 BotBlockerFunction）在 edge 擋掉，
// CF 側此前完全沒擋——同一批掃描器打過來，每個路徑都白跑 ASSETS 404 ＋ Hono 一輪。
// 清單與 BotBlockerFunction 對齊（改任一側請同步另一側）。
// 判斷輸入為 **小寫後的 pathname**。
function isBlockedPath(p) {
  // /.well-known/*（ACME http-01 challenge、security.txt…）是 RFC 8615 標準路徑，
  // 必須在 '/.' 前綴封鎖之前放行，否則憑證續期會在最需要它的時候吃 404。
  if (p.startsWith('/.well-known/')) return false

  return (
    p.endsWith('.php') || /\.php\d*$/.test(p) ||
    p.startsWith('/wp-') || p.startsWith('/wordpress/') ||
    p.startsWith('/.') ||
    p.startsWith('/phpinfo') || p.startsWith('/_profiler') ||
    p.startsWith('/themes/') || p.startsWith('/modules/') ||
    p.startsWith('/plugins/') || p.startsWith('/includes/') ||
    p.startsWith('/vendor/') || p.startsWith('/cgi-bin/') || p.startsWith('/cgi_bin/') ||
    p === '/xmlrpc.php' || p.startsWith('//xmlrpc') ||
    p.startsWith('/admin') ||
    p.startsWith('/joomla') || p.startsWith('/drupal') ||
    p.startsWith('/filemanager') || p.startsWith('/tinyfilemanager') ||
    p.startsWith('/@') ||
    p.startsWith('/graphql') ||
    p.startsWith('/login') || p.startsWith('/register') ||
    p.startsWith('/user/') ||
    p.startsWith('/sftp') ||
    p.startsWith('/stripe') || p.startsWith('/sendgrid') ||
    p.startsWith('/npm-debug') ||
    p.endsWith('.log') ||
    // /api/* bot probes（不是合法 API 路徑——對照 src/app.js 的路由表）
    p === '/api/.env' || p === '/api/env' ||
    p === '/api/config' || p === '/api/settings' ||
    p === '/api/credentials' ||
    p === '/api/swagger' || p === '/api/swagger.json' ||
    p === '/api/graphql' || p === '/api/gql' ||
    p.startsWith('/api/v1/') || p.startsWith('/api/v2/')
  )
}

// ── 縮圖：/tb/{videoId}.jpg → YouTube CDN ────────────────────────────────────
// AWS 主站的 /tb/* 有專屬 origin（ThumbnailBucket，由 runAutoUpdate 落檔）；
// CF 備用站沒有這個 bucket ⇒ 每張縮圖都是「ASSETS 404 → Hono 404 → 前端 onerror
// 才 fallback 到 i.ytimg.com」，一頁列表就是幾十次白跑的 Worker 調用外加一輪空等。
// 直接在 edge 302 過去（CSP 的 img-src 已含該來源，前端 onerror 分支自然不會觸發）。
// videoId 嚴格比對 YouTube 的 11 碼字集：不符就回 404，不讓本路由變成任人指定
// 目的地的開放轉址。
const TB_PATH = /^\/tb\/([A-Za-z0-9_-]{11})\.jpg$/

// ASSETS.fetch() 回傳的 Response headers 是 immutable，直接 set 會拋
// "Can't modify immutable headers"。必須以原 body + init 重建一份可寫的 Response。
// status 可覆寫：SPA fallback 的未知路徑要送 index.html 的 body 但回 404。
function withSecurityHeaders(response, status) {
  const res = status === undefined
    ? new Response(response.body, response)
    : new Response(response.body, { status, headers: response.headers })
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(name, value)
  }
  return res
}

// 尾斜線正規化（'/' 本身除外），與 router.svelte.js 的 normalize() 同語意
function normalizePath(pathname) {
  if (!pathname) return '/'
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return p || '/'
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const pathLower = url.pathname.toLowerCase()

    // 惡意掃描路徑：在碰 ASSETS／Hono 之前就結束
    if (isBlockedPath(pathLower)) {
      return new Response('', { status: 404 })
    }

    // 縮圖 → YouTube CDN（見 TB_PATH 註解）
    const tb = TB_PATH.exec(url.pathname)
    if (tb) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://i.ytimg.com/vi/${tb[1]}/mqdefault.jpg`,
          // 轉址本身可以快取很久——對應關係是固定規則，不隨資料變動
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    }
    if (url.pathname.startsWith('/tb/')) {
      // /tb/ 底下但不是合法的 {11 碼}.jpg：不轉址、不進 ASSETS
      return new Response('', { status: 404 })
    }

    // Try static assets first (skip for /api/ and other known API paths)
    if (env.ASSETS && !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/webhook/') &&
        !url.pathname.startsWith('/trigger-') &&
        url.pathname !== '/health') {
      const assetResponse = await env.ASSETS.fetch(request)
      if (assetResponse.status !== 404) {
        return withSecurityHeaders(assetResponse)
      }
    }

    // Try Hono app (API routes)
    const response = await app.fetch(request, env, ctx)

    // SPA fallback：Hono 404 且 client 要 HTML
    // （/profile、/clothes、/analytics 等 SPA 路由都走這條，同樣要帶 header）
    if (response.status === 404 && env.ASSETS) {
      const accept = request.headers.get('Accept') || ''
      if (accept.includes('text/html')) {
        const known = SPA_ROUTES.has(normalizePath(pathLower))
        const spaResponse = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url)))
        // 未知路徑：body 照樣給 index.html（v3 的 App.svelte 會渲染 NotFound 頁，
        // 使用者看到的是站內的 404 而不是裸錯誤頁），但**狀態碼必須是 404**——
        // 一律回 200 等於 soft 404：搜尋引擎會把打錯的網址當正常頁收錄，
        // 監控／存取日誌也分不出「站壞了」與「網址打錯」。
        return withSecurityHeaders(spaResponse, known ? undefined : 404)
      }
    }

    return response
  },

  async scheduled(event, env, ctx) {
    // CF cron 目前停用（EventBridge 為主要排程）。此處事件不帶 job 欄位，
    // handleCronTrigger 會退回 UTC 小時推斷——見該函式註解。
    ctx.waitUntil(handleCronTrigger(event, env))
  }
}
