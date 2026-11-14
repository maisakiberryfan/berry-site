// 「直連後端原始網址的寫入一律拒絕」的測試（不連網、不連資料庫）：node scripts/test-origin-verify.mjs
//
// 用不存在的路徑發請求：被這一層擋下是 403，放行的話走到路由層回 404，兩者分得出來，
// 而且不會碰到資料庫。
delete process.env.ORIGIN_VERIFY_SECRET

const { default: app } = await import('../src/app.js')

const realLog = console.log.bind(console)
for (const level of ['log', 'warn', 'error']) console[level] = () => {}

let failed = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) failed++
  realLog(ok ? 'PASS' : 'FAIL', name, ok ? '' : `→ got ${got}, want ${want}`)
}

const SECRET = 'test-origin-secret'
// Lambda 鏈路的形狀：API Gateway 會填 requestContext.http.sourceIp
const lambdaEnv = (extra = {}) => ({ requestContext: { http: { sourceIp: '203.0.113.9' } }, ...extra })
const status = async (method, path, headers, env) =>
  (await app.request(path, { method, headers, body: method === 'GET' || method === 'OPTIONS' ? undefined : '{}' }, env)).status
const blocked = async (...args) => (await status(...args)) === 403

const on = lambdaEnv({ ORIGIN_VERIFY_SECRET: SECRET })
const good = { 'x-origin-verify': SECRET, 'content-type': 'application/json' }
const bad = { 'x-origin-verify': 'wrong-value-of-any-length', 'content-type': 'application/json' }
const none = { 'content-type': 'application/json' }

// ── 啟用時：寫入要帶對的驗證值 ──
for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  check(`${method}・沒帶驗證值 → 拒絕`, await blocked(method, '/api/__no_such_route__', none, on), true)
}
check('POST・驗證值錯誤 → 拒絕', await blocked('POST', '/api/__no_such_route__', bad, on), true)
check('POST・驗證值正確 → 放行', await blocked('POST', '/api/__no_such_route__', good, on), false)
check('通知回呼的 POST・沒帶驗證值 → 拒絕', await blocked('POST', '/webhook/youtube/abc', none, on), true)
check('手動觸發的 POST・沒帶驗證值 → 拒絕', await blocked('POST', '/trigger-update', none, on), true)

// ── 讀取不擋 ──
check('GET・沒帶驗證值 → 放行', await blocked('GET', '/api/__no_such_route__', {}, on), false)
check('OPTIONS（預檢）・沒帶驗證值 → 放行', await blocked('OPTIONS', '/api/__no_such_route__', {}, on), false)

// ── 沒設密鑰＝不啟用 ──
check('沒設密鑰・POST 沒帶驗證值 → 放行', await blocked('POST', '/api/__no_such_route__', none, lambdaEnv()), false)

// ── 非 Lambda 鏈路不適用（Cloudflare 備用站、內部調用）──
check('非 Lambda 鏈路・POST 沒帶驗證值 → 放行', await blocked('POST', '/api/__no_such_route__', none, { ORIGIN_VERIFY_SECRET: SECRET }), false)

// ── 被拒的回應不洩漏任何設定 ──
const res = await app.request('/api/__no_such_route__', { method: 'POST', headers: none, body: '{}' }, on)
check('被拒的回應內容固定', await res.text(), JSON.stringify({ error: 'Forbidden' }))

realLog(failed ? `\n${failed} 項失敗` : '\n全部通過')
process.exit(failed ? 1 : 0)
