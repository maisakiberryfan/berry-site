/**
 * 本地開發 entry（Node）— API，加上（有 build 產物時）同源 serve 前端
 *
 * 背景：wrangler dev 的 workerd runtime 連不上自簽 TLS 的 DB
 * （ssl 選項兩條路都不通，見 src/utils/database.js 註解），
 * 此 entry 改用 Node 跑同一份 Hono app：TLS rejectUnauthorized 可用、
 * DB 設定與 Lambda 同走 process.env（platform.js fallback）。
 *
 * 用法（配合 ssh tunnel 連 DB，寫入測試一律用 mbdb_test）：
 *   1. ssh -N -L 13307:127.0.0.1:<DB 主機上的埠> <DB 主機>
 *   2. DB_HOST=127.0.0.1 DB_PORT=13307 DB_NAME=mbdb_test node entry-dev.js
 *   → http://localhost:8788
 *
 * 前端有兩種看法：
 *   A. 改前端時：另開 `cd fansite-v2 && npm run dev:testdb`（:5175，有 HMR），
 *      它把 /api 代理到本程序。這時本程序只當 API 後端，不需要先 build
 *   B. 看 build 後的成品：先 `cd fansite-v2 && npm run build`，再直接開 :8788。
 *      請求處理重用 entry-worker.js 的 fetch（做法同 entry-node.js）——頁面路由白名單、
 *      分享預覽（OG）快照、/tb 縮圖轉址、安全標頭都是正式環境的同一份程式
 *
 * 與 entry-node.js 的差別：錯誤回應帶真實訊息（MODE=dev）、沒有排程、沒有內建歌單比對、
 * 自動讀 repo 根 .env。不要拿來當正式環境。
 *
 * 其餘變數（DB_USER/DB_PASSWORD/API key 等）自動讀 repo 根 .env；
 * 命令列注入的環境變數優先於 .env。
 */
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import worker from './entry-worker.js'

// cwd 錨定到本檔所在目錄：serveStatic 的相對 root 以 process.cwd() 解析，
// 從別處啟動（如 git worktree 的 launch config）會 serve 到錯的目錄
process.chdir(dirname(fileURLToPath(import.meta.url)))

// .env → process.env（不覆蓋已存在的值，讓命令列 override 優先）
try {
  for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    if (!line.includes('=') || line.trimStart().startsWith('#')) continue
    const k = line.slice(0, line.indexOf('=')).trim()
    if (k in process.env) continue
    let v = line.slice(line.indexOf('=') + 1).trim()
    // 剝除成對的包裹引號：dotenv 慣例允許 KEY="value"／KEY='value'（值含空白、`#`
    // 或前後空白時是必要寫法）。不剝的話引號會變成值的一部分——密碼多兩個字元，
    // 而 DB 只會回一句 "Access denied"，看不出是引號的問題。
    // 只剝「頭尾同款且成對」的那一層，值本身內含的引號不動。
    if (v.length >= 2 &&
        ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1)
    }
    process.env[k] = v
  }
} catch { /* 無 .env 時仰賴外部環境變數 */ }

// 防呆：dev server 預期連 mbdb_test（DB 測試規範）；沒 override 時 .env 的正式庫
// 參考值會被讀入——大聲警告避免對正式庫誤寫
if (process.env.DB_NAME !== 'mbdb_test') {
  console.warn(`⚠️  [entry-dev] DB_NAME=${process.env.DB_NAME || '(未設定)'} 不是 mbdb_test！`)
  console.warn('⚠️  寫入測試請用：DB_HOST=127.0.0.1 DB_PORT=13307 DB_NAME=mbdb_test node entry-dev.js')
}

// ── 靜態檔：取代 Workers 的 ASSETS binding ───────────────────────────────────
// 路徑對應與 entry-node.js 相同（改那邊的對應時這裡要跟著改），差別只在一律 no-cache：
// 重新 build 之後重新整理就要看到新的。
// 沒有 build 產物時不提供 ASSETS——entry-worker.js 遇到沒有 ASSETS 的環境只跑 API，
// 剛好就是「只當 API 後端、前端交給 Vite」的用法，不必為了開後端先 build 一次。
const hasDist = existsSync('./fansite-v2/dist/index.html')
let ASSETS
if (hasDist) {
  const noCache = (_path, c) => { c.header('Cache-Control', 'no-cache') }
  const assets = new Hono()
  // 年表與首頁「最近更新」直接讀 repo 內的原始檔（/data/ 是前端讀的位置，另一組是快照腳本抓的原位）
  for (const p of ['/data/history.md', '/pages/history.md']) {
    // serveStatic 的 MIME 表不認得 .md（會給 application/octet-stream），自己補上
    assets.get(p, async (c, next) => {
      await next()
      if (c.res.ok) c.res.headers.set('Content-Type', 'text/markdown; charset=utf-8')
    }, serveStatic({ path: './fansite/pages/history.md', onFound: noCache }))
  }
  for (const p of ['/data/changelog.json', '/changelog.json']) {
    assets.get(p, serveStatic({ path: './fansite/changelog.json', onFound: noCache }))
  }
  // 資料快照：`npm run snapshot` 產到 public/data/；沒有才退回 build 當時複製進 dist 的那份
  assets.use('/data/*', serveStatic({ root: './fansite-v2/public', onFound: noCache }))
  assets.use('/img/*', serveStatic({ root: './fansite', onFound: noCache }))
  assets.use('*', serveStatic({ root: './fansite-v2/dist', onFound: noCache }))
  ASSETS = { fetch: (req) => assets.fetch(req) }
}

// 傳給 Hono app 的 env（形狀比照 entry-lambda.js：Lambda 上是 `{}`，真值全在
// process.env，由 platform.js 的 getSecret/getDbConfig fallback 取得）。
// 多帶一個 MODE：app.js 的 onError 只在 MODE 為 dev/test 時把真實錯誤訊息放進回應
// （正式環境一律泛化，不外洩 DB 細節）——不帶的話本地除錯只看得到
// "Internal server error"，等於白開一個本地後端。同 snapshot.js 內部調用的作法。
const DEV_ENV = { MODE: 'dev', ...(ASSETS && { ASSETS }) }

// Workers 的 ctx.waitUntil：回應送出後繼續跑的背景工作（YouTube 通知的後續處理用它）
const ctx = {
  waitUntil(promise) { Promise.resolve(promise).catch((err) => console.error('[entry-dev] 背景工作失敗：', err)) },
  passThroughOnException() {}
}

const port = Number(process.env.DEV_PORT || 8788)
serve({ fetch: (request) => worker.fetch(request, DEV_ENV, ctx), port }, () => {
  console.log(`[entry-dev] http://localhost:${port}  DB=${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`)
  console.log(hasDist
    ? '[entry-dev] 前端：fansite-v2/dist（build 產物；改前端請用 cd fansite-v2 && npm run dev:testdb）'
    : '[entry-dev] 前端：沒有 fansite-v2/dist，只提供 API。看頁面請用 cd fansite-v2 && npm run dev:testdb，或先 npm run build')
})
