/**
 * YouTube PubSubHubbub 回呼網址的保護。
 *
 * 問題：hub 不驗證「誰」發出訂閱請求，只會回頭問回呼網址要不要這個訂閱。回呼網址若是固定、
 * 猜得到的（/webhook/youtube），任何人都能替它發訂閱並指定自己的 hub.secret——訂閱密鑰被換掉後，
 * 真正的通知會因簽章不符被拒收，直到站台自己下一次續訂（2026-11-13 實際發生過，起因是測試環境）。
 *
 * 做法：回呼網址尾端多一段由 TRIGGER_TOKEN 算出來的字串。訂閱是以「回呼網址＋頻道」為單位，
 * 外人不知道這一段就碰不到我們的訂閱；別的部署算出來的是它自己密鑰的字串，路徑也對不上。
 * 這一段不寫進任何設定或文件：PUBSUB_CALLBACK_URL 仍然只填 https://<網域>/webhook/youtube，
 * 續訂時由程式接上。
 *
 * 只用 Web Crypto，Workers／Lambda／Node 都能跑。
 */

// 改這個標籤等於換一組路徑段（所有訂閱要重新建立），沒事不要動
const KEY_LABEL = 'pubsub-callback-v1'

/** 由密鑰算出回呼路徑段：HMAC-SHA256 的前 32 個 hex（128 bit） */
export async function pubsubCallbackKey(secret) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(KEY_LABEL))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

/**
 * 續訂時實際送給 hub 的回呼網址。
 * 回呼基底或密鑰任一沒設就回 null——沒有密鑰既算不出路徑段、也驗不了通知的簽章，訂了也沒用。
 */
export async function pubsubCallbackUrl(baseUrl, secret) {
  if (!baseUrl || !secret) return null
  return `${String(baseUrl).replace(/\/+$/, '')}/${await pubsubCallbackKey(secret)}`
}
