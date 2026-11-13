// 單機入口的純函式測試（不連網、不連資料庫）：node scripts/test-node-runtime.mjs
import { dueJobs, parseTrustedProxies, resolveClientIp, isLoopback } from '../src/node-runtime.js'

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : `→ got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}
const at = (hhmm) => new Date(`2026-11-13T${hhmm}:00Z`)

// 排程表：對照 template.yaml 的 EventBridge 規則
check('07:00 每日更新', dueJobs(at('07:00')), ['daily'])
check('07:30 快照', dueJobs(at('07:30')), ['snapshot'])
check('20:00 快照', dueJobs(at('20:00')), ['snapshot'])
check('14:00 輪詢開始', dueJobs(at('14:00')), ['polling'])
check('19:50 輪詢最後一發', dueJobs(at('19:50')), ['polling'])
check('20:10 已過輪詢窗口', dueJobs(at('20:10')), [])
check('13:50 輪詢窗口前', dueJobs(at('13:50')), [])
check('14:05 非整十分', dueJobs(at('14:05')), [])
check('07:01 不重複觸發', dueJobs(at('07:01')), [])
let polling = 0, daily = 0, snapshot = 0
for (let i = 0; i < 1440; i++) {
  const jobs = dueJobs(new Date(Date.UTC(2026, 10, 13, 0, i)))
  polling += jobs.includes('polling'); daily += jobs.includes('daily'); snapshot += jobs.includes('snapshot')
}
check('一天的觸發次數（輪詢 36／每日 1／快照 2）', [polling, daily, snapshot], [36, 1, 2])

// 訪客 IP
const docker = parseTrustedProxies('172.28.0.0/24')
check('直接對外：用對端位址', resolveClientIp('203.0.113.7', undefined, docker), '203.0.113.7')
check('直接對外：訪客偽造 XFF 不採信', resolveClientIp('203.0.113.7', '1.2.3.4', docker), '203.0.113.7')
check('本機代理：取 XFF 最後一段', resolveClientIp('127.0.0.1', '9.9.9.9, 198.51.100.4', docker), '198.51.100.4')
check('本機代理（IPv6 loopback）', resolveClientIp('::1', '198.51.100.4', docker), '198.51.100.4')
check('Docker 網段內的代理：取 XFF 最後一段', resolveClientIp('172.28.0.3', '9.9.9.9, 198.51.100.4', docker), '198.51.100.4')
check('IPv4-mapped 位址的代理', resolveClientIp('::ffff:172.28.0.3', '198.51.100.4', docker), '198.51.100.4')
check('網段外的位址不算代理', resolveClientIp('172.29.0.3', '198.51.100.4', docker), '172.29.0.3')
check('沒設 TRUSTED_PROXIES 時 Docker 位址不算代理', resolveClientIp('172.28.0.3', '198.51.100.4', []), '172.28.0.3')
check('代理沒附 XFF：退回對端位址', resolveClientIp('172.28.0.3', '', docker), '172.28.0.3')
check('本機直連（沒有代理）', resolveClientIp('127.0.0.1', undefined, docker), '127.0.0.1')
check('XFF 為陣列', resolveClientIp('127.0.0.1', ['1.1.1.1', '2.2.2.2'], docker), '2.2.2.2')
check('單一位址寫法', resolveClientIp('10.0.0.5', '198.51.100.4', parseTrustedProxies('10.0.0.5')), '198.51.100.4')
check('多段清單', parseTrustedProxies('172.28.0.0/24, 10.0.0.5').length, 2)
check('空值＝空清單', parseTrustedProxies('').length, 0)
check('isLoopback', [isLoopback('127.0.0.1'), isLoopback('::1'), isLoopback('172.28.0.1')], [true, true, false])
for (const bad of ['abc', '300.1.1.1/24', '10.0.0.0/33', '10.0.0/24']) {
  let threw = false
  try { parseTrustedProxies(bad) } catch { threw = true }
  check(`格式錯誤要拋錯：${bad}`, threw, true)
}

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過')
process.exit(failed ? 1 : 0)
