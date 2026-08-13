/**
 * Cloudflare Worker entry point
 * Handles: API routes (Hono) + Static Assets + SPA fallback
 *
 * Flow:
 * 1. Try static assets first (CSS, JS, images, etc.)
 * 2. If not a static file, try Hono app (API routes)
 * 3. If Hono 404 + client accepts HTML → SPA fallback (index.html)
 */

import app, { handleCronTrigger } from './src/app.js'

// ── Security headers（靜態資源用）────────────────────────────────────────────
// 靜態檔案由 env.ASSETS.fetch() 直接回傳、完全不經過 Hono，所以 src/app.js 的
// header middleware 覆蓋不到——CF 站要讓 HTML 帶 CSP，唯一位置就是這裡。
//
// CSP 各 source 的依據（改前端資源來源時必須同步檢查 template.yaml 的同一份字串）：
//   script-src  'wasm-unsafe-eval'        sql.js（SQLite/WASM）模組編譯，
//                                         analytics/engine.js self-host 於 /assets/vendor/
//   img-src     https://i.ytimg.com       tool.js 縮圖 fallback（/tb/ 缺圖時）
//               data:                     bootstrap/select2 CSS 內的 data:image/svg+xml（23 處）
//   font-src    'self'                    bootstrap-icons woff/woff2 由 esbuild 落在 /assets/dist/
//   media-src   'self'                    profile.js:16 BGM mp3（img/profile/bgm/*.mp3）
//   style-src   'unsafe-inline'           index.html:20 的 <style> 與各處 style="" 屬性
//                                         （Tabulator/Bootstrap/Fancybox 大量使用，無法收斂）
//   script-src 刻意「不含」'unsafe-inline'：三頁 inline script 已外抽成 /assets/js/*.js
//   走 dynamic import()，xlsx 與 sql.js 走原生 <script src>（tool.js / analytics/engine.js）。
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

// ASSETS.fetch() 回傳的 Response headers 是 immutable，直接 set 會拋
// "Can't modify immutable headers"。必須以原 body + init 重建一份可寫的 Response。
function withSecurityHeaders(response) {
  const res = new Response(response.body, response)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(name, value)
  }
  return res
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

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

    // SPA fallback: if Hono 404 and client accepts HTML, serve index.html
    // （/profile、/clothes、/analytics 等 SPA 路由都走這條，同樣要帶 header）
    if (response.status === 404 && env.ASSETS) {
      const accept = request.headers.get('Accept') || ''
      if (accept.includes('text/html')) {
        const spaResponse = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url)))
        return withSecurityHeaders(spaResponse)
      }
    }

    return response
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCronTrigger(event, env))
  }
}
