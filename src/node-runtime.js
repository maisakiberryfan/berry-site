/**
 * entry-node.js（單機部署入口）用的純函式：排程表與訪客 IP 判定。
 * 抽出來是為了能單獨測試——入口本身一 import 就會啟動伺服器。
 * 測試：node scripts/test-node-runtime.mjs
 */

// ── 排程表（UTC）─────────────────────────────────────────────────────────────
// ⚠️ 抄自 template.yaml 的 EventBridge 規則，兩邊必須一致：
//   daily     cron(0 7 * * ? *)          每日更新（台灣 15:00）
//   polling   cron(0/10 14-19 * * ? *)   直播結束後的輪詢（台灣 22:00~03:50）
//   snapshot  cron(30 7 …)、cron(0 20 …) 重產資料快照
export const SCHEDULE = [
  { name: 'daily', due: (h, m) => h === 7 && m === 0 },
  { name: 'polling', due: (h, m) => h >= 14 && h <= 19 && m % 10 === 0 },
  { name: 'snapshot', due: (h, m) => (h === 7 && m === 30) || (h === 20 && m === 0) }
]

/** 這一分鐘該跑哪些工作（回傳名稱陣列） */
export function dueJobs(date) {
  const h = date.getUTCHours()
  const m = date.getUTCMinutes()
  return SCHEDULE.filter((job) => job.due(h, m)).map((job) => job.name)
}

// ── 訪客 IP ──────────────────────────────────────────────────────────────────
export const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

function ip4ToInt(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const v = Number(part)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

/**
 * 解析 TRUSTED_PROXIES：逗號分隔的 IPv4 位址或 CIDR（例 `172.28.0.0/24,10.0.0.5`）。
 * 寫錯就直接拋錯——靜靜忽略會讓限流把所有訪客算成同一個人，而且看不出原因。
 */
export function parseTrustedProxies(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [ip, bitsText = '32'] = entry.split('/')
    const base = ip4ToInt(ip)
    const bits = Number(bitsText)
    if (base === null || !/^\d{1,2}$/.test(bitsText) || bits > 32) {
      throw new Error(`TRUSTED_PROXIES 格式錯誤：「${entry}」（要 IPv4 位址或 CIDR）`)
    }
    const size = 2 ** (32 - bits)
    const lo = Math.floor(base / size) * size
    return { lo, hi: lo + size - 1 }
  })
}

/**
 * 決定限流用的訪客 IP。
 *   對端不是受信任的代理 → 用對端位址（訪客自己送的 X-Forwarded-For 一律不採信）
 *   對端是 loopback 或在 trusted 清單內 → 用 X-Forwarded-For 的**最後一段**，
 *   那是代理自己附加的，訪客改不到；代理沒附就退回對端位址
 */
export function resolveClientIp(remoteAddress, xForwardedFor, trusted = []) {
  const remote = String(remoteAddress || '').replace(/^::ffff:/, '')
  const n = ip4ToInt(remote)
  const fromProxy = isLoopback(remoteAddress) || (n !== null && trusted.some((r) => n >= r.lo && n <= r.hi))
  if (fromProxy) {
    const xff = Array.isArray(xForwardedFor) ? xForwardedFor.join(',') : String(xForwardedFor || '')
    const last = xff.split(',').pop().trim()
    if (last) return last
  }
  return remote || 'unknown'
}
