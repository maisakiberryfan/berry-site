// YouTube 通知回呼的防護測試（不連網、不連資料庫）：node scripts/test-pubsub.mjs
//
// 對 Hono app 直接發請求；通知內容一律用「不是我們的頻道」，處理會在驗完簽章後就結束，
// 不會進到真的抓資料那一段。
import { createHmac } from 'node:crypto'

delete process.env.TRIGGER_TOKEN
delete process.env.PUBSUB_CALLBACK_URL

const { default: app } = await import('../src/app.js')
const { pubsubCallbackKey, pubsubCallbackUrl } = await import('../src/utils/pubsub.js')
const { renewPubSubSubscription } = await import('../src/cron-jobs/auto-update.js')
const { CONFIG } = await import('../src/config.js')

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  realLog(ok ? 'PASS' : 'FAIL', name, ok ? '' : `→ got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// 攔下 console，之後用訊息內容判斷程式走到哪一步
const realLog = console.log.bind(console)
let logs = []
for (const level of ['log', 'warn', 'error']) console[level] = (...args) => { logs.push(args.join(' ')) }
const logged = (text) => logs.some((line) => line.includes(text))

const SECRET = 'test-trigger-token'
const env = { TRIGGER_TOKEN: SECRET }
const key = await pubsubCallbackKey(SECRET)
const otherKey = await pubsubCallbackKey('someone-elses-token')
const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CONFIG.berryChannels[0]}`
const verifyQuery = (mode, t) => `?hub.mode=${mode}&hub.topic=${encodeURIComponent(t)}&hub.challenge=abc123`
const get = async (path, e = env) => { logs = []; const r = await app.request(path, {}, e); return [r.status, await r.text()] }

// ── 路徑段 ──
check('路徑段是 32 個 hex', /^[0-9a-f]{32}$/.test(key), true)
check('同一把密鑰每次算出一樣的路徑段', await pubsubCallbackKey(SECRET), key)
check('不同密鑰算出不同的路徑段', key === otherKey, false)
check('回呼網址＝設定值＋路徑段', await pubsubCallbackUrl('https://example.test/webhook/youtube', SECRET), `https://example.test/webhook/youtube/${key}`)
check('設定值尾端的斜線不重複', await pubsubCallbackUrl('https://example.test/webhook/youtube/', SECRET), `https://example.test/webhook/youtube/${key}`)
check('沒有密鑰或沒有設定值就不產生網址', [await pubsubCallbackUrl('https://example.test/x', ''), await pubsubCallbackUrl('', SECRET)], [null, null])

// ── 訂閱驗證（hub 來問要不要這個訂閱）──
check('新路徑・正確路徑段・訂閱我們的頻道 → 回 challenge', await get(`/webhook/youtube/${key}${verifyQuery('subscribe', topic)}`), [200, 'abc123'])
check('新路徑・錯的路徑段 → 404', (await get(`/webhook/youtube/${'0'.repeat(32)}${verifyQuery('subscribe', topic)}`))[0], 404)
check('新路徑・別的部署算出的路徑段 → 404', (await get(`/webhook/youtube/${otherKey}${verifyQuery('subscribe', topic)}`))[0], 404)
check('新路徑・正確路徑段・但要退訂 → 404', (await get(`/webhook/youtube/${key}${verifyQuery('unsubscribe', topic)}`))[0], 404)
check('新路徑・正確路徑段・別人的頻道 → 404', (await get(`/webhook/youtube/${key}${verifyQuery('subscribe', 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCsomeoneelse')}`))[0], 404)
check('站台沒設密鑰時新路徑一律 404', (await get(`/webhook/youtube/${key}${verifyQuery('subscribe', topic)}`, {}))[0], 404)
check('舊路徑在過渡期仍接受訂閱驗證', await get(`/webhook/youtube${verifyQuery('subscribe', topic)}`), [200, 'abc123'])

// ── 通知 ──
const body = '<feed><entry><yt:videoId>abcdefghijk</yt:videoId><yt:channelId>UCnotOurChannel</yt:channelId></entry></feed>'
const sign = (secret) => 'sha1=' + createHmac('sha1', secret).update(body).digest('hex')
const post = async (path, signature, e = env) => {
  logs = []
  const r = await app.request(path, { method: 'POST', headers: signature ? { 'X-Hub-Signature': signature } : {}, body }, e)
  return r.status
}
check('新路徑・正確簽章 → 200', await post(`/webhook/youtube/${key}`, sign(SECRET)), 200)
check('　　且沒有被當成簽章錯誤', [logged('驗證失敗'), logged('拒絕無簽名')], [false, false])
check('新路徑・用別的密鑰簽 → 200 但被忽略', await post(`/webhook/youtube/${key}`, sign('someone-elses-token')), 200)
check('　　且記錄為簽章驗證失敗', logged('X-Hub-Signature 驗證失敗'), true)
check('新路徑・沒有簽章 → 200 但被忽略', await post(`/webhook/youtube/${key}`, null), 200)
check('　　且記錄為拒絕無簽名', logged('拒絕無簽名'), true)
check('錯的路徑段・即使簽章正確 → 404', await post(`/webhook/youtube/${otherKey}`, sign(SECRET)), 404)
check('舊路徑在過渡期仍收通知', await post('/webhook/youtube', sign(SECRET)), 200)
check('　　且沒有被當成簽章錯誤', logged('驗證失敗'), false)

// ── 續訂送出的內容 ──
const realFetch = globalThis.fetch
let sent = []
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), form: new URLSearchParams(init.body) }); return { status: 202 } }
const renew = async (e) => { sent = []; logs = []; return renewPubSubSubscription(e) }

check('有回呼設定與密鑰 → 續訂成功', await renew({ PUBSUB_CALLBACK_URL: 'https://example.test/webhook/youtube', TRIGGER_TOKEN: SECRET }), true)
check('　　每個頻道各送一次', sent.length, CONFIG.berryChannels.length)
check('　　送出的回呼網址都帶路徑段', [...new Set(sent.map((s) => s.form.get('hub.callback')))], [`https://example.test/webhook/youtube/${key}`])
check('　　不再續訂沒有路徑段的舊網址', sent.some((s) => s.form.get('hub.callback') === 'https://example.test/webhook/youtube'), false)
check('　　hub.secret 是站台的密鑰', [...new Set(sent.map((s) => s.form.get('hub.secret')))], [SECRET])
check('　　路徑段沒有被印進 log', logs.some((line) => line.includes(key)), false)
check('沒有回呼設定 → 不送任何請求', [await renew({ TRIGGER_TOKEN: SECRET }), sent.length], [false, 0])
check('沒有密鑰 → 不送任何請求', [await renew({ PUBSUB_CALLBACK_URL: 'https://example.test/webhook/youtube' }), sent.length], [false, 0])
globalThis.fetch = realFetch

realLog(failed ? `\n${failed} 項失敗` : '\n全部通過')
process.exit(failed ? 1 : 0)
