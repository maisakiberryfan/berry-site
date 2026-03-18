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
        return assetResponse
      }
    }

    // Try Hono app (API routes)
    const response = await app.fetch(request, env, ctx)

    // SPA fallback: if Hono 404 and client accepts HTML, serve index.html
    if (response.status === 404 && env.ASSETS) {
      const accept = request.headers.get('Accept') || ''
      if (accept.includes('text/html')) {
        return env.ASSETS.fetch(new Request(new URL('/index.html', request.url)))
      }
    }

    return response
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCronTrigger(event, env))
  }
}
