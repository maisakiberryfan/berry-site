/**
 * 本地開發 entry（Node）— 同源 serve fansite 靜態檔案 + API
 *
 * 背景：wrangler dev 的 workerd runtime 連不上自簽 TLS 的 DB
 * （ssl 選項兩條路都不通，見 src/utils/database.js 註解），
 * 此 entry 改用 Node 跑同一份 Hono app：TLS rejectUnauthorized 可用、
 * DB 設定與 Lambda 同走 process.env（platform.js fallback）。
 *
 * 用法（配合 ssh tunnel 連 DB，寫入測試一律用 mbdb_test）：
 *   1. ssh -N -L 13307:127.0.0.1:8081 rsshub.kat-ani.win
 *   2. DB_HOST=127.0.0.1 DB_PORT=13307 DB_NAME=mbdb_test node entry-dev.js
 *   → http://localhost:8788
 *
 * 其餘變數（DB_USER/DB_PASSWORD/API key 等）自動讀 repo 根 .env；
 * 命令列注入的環境變數優先於 .env。
 */
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import app from './src/app.js'

// cwd 錨定到本檔所在目錄：serveStatic 的相對 root 以 process.cwd() 解析，
// 從別處啟動（如 git worktree 的 launch config）會 serve 到錯的 fansite/
process.chdir(dirname(fileURLToPath(import.meta.url)))

// .env → process.env（不覆蓋已存在的值，讓命令列 override 優先）
try {
  for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    if (!line.includes('=') || line.trimStart().startsWith('#')) continue
    const k = line.slice(0, line.indexOf('=')).trim()
    if (!(k in process.env)) process.env[k] = line.slice(line.indexOf('=') + 1).trim()
  }
} catch { /* 無 .env 時仰賴外部環境變數 */ }

// 防呆：dev server 預期連 mbdb_test（DB 測試規範）；沒 override 時 .env 的正式庫
// 參考值會被讀入——大聲警告避免對正式庫誤寫
if (process.env.DB_NAME !== 'mbdb_test') {
  console.warn(`⚠️  [entry-dev] DB_NAME=${process.env.DB_NAME || '(未設定)'} 不是 mbdb_test！`)
  console.warn('⚠️  寫入測試請用：DB_HOST=127.0.0.1 DB_PORT=13307 DB_NAME=mbdb_test node entry-dev.js')
}

const indexHtml = readFileSync(new URL('./fansite/index.html', import.meta.url), 'utf8')

const dev = new Hono()
// 路徑切割對齊 production（entry-worker.js / CloudFront behaviors）：只有 API 前綴
// 進 Hono app——否則 app 的 GET /（API 資訊 JSON）會攔住根路徑，首頁變成 JSON
dev.use('*', async (c, next) => {
  const p = new URL(c.req.url).pathname
  if (p.startsWith('/api/') || p.startsWith('/webhook/') || p.startsWith('/trigger-') || p === '/health') {
    return app.fetch(c.req.raw)
  }
  await next()
})
dev.use('*', serveStatic({ root: './fansite' }))     // 靜態檔案
dev.get('*', (c) => {                                // SPA fallback（模仿 BotBlockerFunction 的 rewrite）
  const accept = c.req.header('Accept') || ''
  return accept.includes('text/html') ? c.html(indexHtml) : c.notFound()
})

const port = Number(process.env.DEV_PORT || 8788)
serve({ fetch: dev.fetch, port }, () => {
  console.log(`[entry-dev] http://localhost:${port}  DB=${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`)
})
