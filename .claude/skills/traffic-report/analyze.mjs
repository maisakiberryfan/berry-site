// CloudFront 存取日誌本地分析（零 AWS 分析服務；輸出 markdown 到 stdout）
// 用法: node analyze.mjs <cf_filtered.tsv> <ip_country.tsv> [extra-internal-ip-prefixes,comma-separated]
//   cf_filtered.tsv ＝ zcat 全部日誌、去掉 # 註解、依時間篩選後的原始 TSV（33 欄）
//   ip_country.tsv  ＝ lookup-country.mjs 的輸出（IP\tISO-2）
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , tsvPath, ipcPath, extraInternal = ''] = process.argv
// 自家（開發者）IP／前綴：讀同目錄 internal-ips.txt（**gitignored**；每行一個 IP 或前綴，
// `#` 開頭為註解）＋ CLI 第三參數（逗號分隔）。repo 為 public，個人 IP 不得硬編在這支檔。
const ipsFile = join(dirname(fileURLToPath(import.meta.url)), 'internal-ips.txt')
const fileInternal = existsSync(ipsFile)
  ? readFileSync(ipsFile, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
  : []
const INTERNAL_PREFIXES = [...fileInternal, ...extraInternal.split(',').map(s => s.trim()).filter(Boolean)]
if (!INTERNAL_PREFIXES.length) console.error('warn: internal-ips.txt 不存在且未給參數——開發者流量會落到 Real User／Unknown')

const ipCountry = new Map()
for (const line of readFileSync(ipcPath, 'utf8').split('\n')) {
  const [ip, cc] = line.split('\t'); if (ip) ipCountry.set(ip, cc || '??')
}

const SEARCH_UA = /googlebot|bingbot|bingpreview|applebot|duckduckbot|yandexbot|baiduspider|amazonbot|amzn-searchbot|petalbot|seznambot|qwantify/i
const AI_UA = /gptbot|chatgpt-user|oai-searchbot|claudebot|claude-user|claude-searchbot|anthropic-ai|perplexitybot|perplexity-user|ccbot|mistralai-user|meta-externalagent|meta-externalfetcher|cohere-ai|diffbot|timpibot|omgili|youbot/i
const SOCIAL_UA = /facebookexternalhit|facebookbot|twitterbot|discordbot|whatsapp|slackbot|linkedinbot|telegrambot|line-poker|skypeuripreview|pinterestbot|mastodon|misskey|bluesky|iframely|embedly/i
const MAL_UA = /bytespider|ahrefsbot|semrushbot|mj12bot|dotbot|palo alto networks|l9scan|leakix|expanse|censys|shodan|zgrab|masscan|nmap|nuclei|sqlmap|nikto|wpscan|internetmeasurement|criminalip|netsystemsresearch|dataforseo|barkrowler|serpstatbot|iphone os 13_2_3|quic-go|android 5\.0; sm-g900p|wordpress\/\d/i
const MAL_PATH = [
  /\.php(\?|$)/i, /\/wp-/i, /\/wordpress\b/i, /^\/(wp|wordpress|blog)\/?$/i, /wp-json/i,
  /\/\.env/i, /\/\.git/i, /xmlrpc/i, /\/cgi-bin/i, /\/admin(\/|$|\.)/i, /wlwmanifest/i, /\/alfa_data/i,
  /\/vendor\//i, /hnap1/i, /boaform/i, /\/media\/system\//i, /\/cdn\.js$/i, /aws-?config/i, /\.\./,
  /\/\.(aws|ssh|docker|vscode|idea|svn|hg|npmrc|htpasswd|htaccess|DS_Store)/i,
  /\/(secrets?|credentials?|service-account|firebase-config|rclone|config|settings|env)\.(json|ya?ml|js|ini|conf|txt|xml|php|bak|old)$/i,
  /\/phpinfo/i, /\/(shell|cmd|eval|backup|dump|db|database)\.(php|sql|zip|tar|gz|bak)/i,
  /\/(id_rsa|id_dsa|\.bash_history|\.pgpass|\.netrc)/i, /\/(graphql|gql)(\/|$)/i, /\/v[12]\/(config|settings|graphql)/i,
  /\/(server-status|actuator|console|manager|jmx-console|solr|jenkins|phpmyadmin|pma|mysql|adminer|_ignition|telescope|debug)\b/i,
  /\/\.well-known\/(?!acme-challenge)/i, /-debug-trigger-/i, /\/(user\/login|signin|portal)$/i, /\/dist\/manifest\.json$/i,
  /\/(owa|ecp|autodiscover|remote|rdweb|vpn|sslvpn|global-protect|dana-na)\b/i, /\/geoserver/i,
  /\/api\/(\.env|env|config|settings|openapi\.json|v\d\/(config|settings)|health)$/i,
  /\/(openapi\.json|swagger|manifest\.webmanifest|api-docs)/i, /\/(login|logon|auth)\.(php|aspx?|jsp)/i,
  /^\/(login|signup|signin|sign-in|register|account|dashboard|fetch|users?\/login|auth\/callback|logout|oauth)\/?$/i,
  /\/@fs\//i, /\/static\/\//i, /\/js\/(config|env|settings)\.js$/i, /\/__\/firebase/i, /\/laravel\//i, /\/actuator/i,
  /\/(docker-compose|gradle\.properties|package-lock|composer)\.(ya?ml|json|properties)/i, /\/\.(zshrc|bashrc|profile|env\.\w+)/i,
]
const isMalPath = (p) => MAL_PATH.some(r => r.test(p))
const BROWSER_UA = (ua) => /^Mozilla\//.test(ua) && !/bot|crawl|spider|headless|electron|go-http|quic-go|curl|python|wget|java|okhttp|node|scan|preview|fetch|claude|palo alto|iphone os 13_2_3/i.test(ua)
const REAL_MARKERS = [
  /^\/assets\/index-[A-Za-z0-9_-]+\.js$/, /^\/assets\/[A-Za-z0-9_]+-[A-Za-z0-9_-]{8}\.js$/,
  /^\/assets\/dist\/tool\.(js|css)$/, /^\/data\/manifest\.json$/, /^\/api\/setlist\/manifest$/,
  /^\/api\/yt\/latest$/, /^\/api\/stats\/last-updated$/, /^\/api\/songlist\.json$/, /^\/assets\/data\/nav\.json$/,
]
const SPA_ROUTE = /^\/(songlist|setlist|streamlist|aliases|analytics|clothes|discography|profile|history|about|links|schedule)?(\/[^\/?]*)?$/
const isInternal = (r) => INTERNAL_PREFIXES.some(p => r.ip.startsWith(p)) || r.ua === 'node' || /localhost:\d+/.test(r.referer) || /Claude\/1\.\d+.*Electron/.test(r.ua) || (r.uri === '/webhook/youtube' && /FeedFetcher-Google/.test(r.ua))

const rows = []
for (const line of readFileSync(tsvPath, 'utf8').split('\n')) {
  if (!line) continue
  const f = line.split('\t')
  let ua = f[10]; try { ua = decodeURIComponent(ua) } catch { }
  let uri = f[7]; try { uri = decodeURIComponent(uri) } catch { }
  rows.push({
    date: f[0], time: f[1], edge: f[2], bytes: +f[3] || 0, ip: f[4], method: f[5], uri, status: f[8],
    referer: f[9], ua, resultType: f[13], hostHeader: f[15], protocol: f[16], detailed: f[28] || f[13], cc: ipCountry.get(f[4]) || '??'
  })
}

// 截斷／畸形瀏覽器 UA（無 Chrome/Safari token、或缺 AppleWebKit）＝掃描器常見特徵
const ODD_UA = (ua) => /AppleWebKit\/537\.36$/.test(ua) || /^Mozilla\/5\.0 \([^)]*\) Chrome\/\d+\.0\.0\.0$/.test(ua) || /^"Mozilla/.test(ua)
const TYPES = ['Real User', 'Search Engine', 'AI Bot', 'Social Preview', 'Malicious Bot', 'Internal', 'Unknown']
// 第一輪：請求級（不含真人判定）
function preType(r) {
  if (isInternal(r)) return 'Internal'
  if (isMalPath(r.uri)) return 'Malicious Bot'
  if (SEARCH_UA.test(r.ua)) return 'Search Engine'
  if (AI_UA.test(r.ua)) return 'AI Bot'
  if (SOCIAL_UA.test(r.ua)) return 'Social Preview'
  if (MAL_UA.test(r.ua) || ODD_UA(r.ua) || r.ua === '-' || r.ua === '') return 'Malicious Bot'
  return 'Unknown'
}
// IP 級：真人判定＝(瀏覽器型 UA 載入 SPA bundle／入口 API) ∧ 同 IP 零惡意請求 ∧ 無 bot UA ∧ 有站內脈絡（referer m-b.win 或 SPA 路由 200/304）
const ipInfo = new Map()
for (const r of rows) {
  const t = preType(r); r.pre = t
  const s = ipInfo.get(r.ip) || { n: 0, mal: 0, botUa: 0, marker: 0, ctx: 0 }
  s.n++
  if (t === 'Malicious Bot') s.mal++
  if (t === 'Search Engine' || t === 'AI Bot' || t === 'Social Preview') s.botUa++
  if (t === 'Unknown' && BROWSER_UA(r.ua) && REAL_MARKERS.some(m => m.test(r.uri))) s.marker++
  if (/m-b\.win/.test(r.referer) || (SPA_ROUTE.test(r.uri) && (r.status === '200' || r.status === '304'))) s.ctx++
  ipInfo.set(r.ip, s)
}
const realIps = new Set([...ipInfo].filter(([, s]) => s.marker > 0 && s.mal === 0 && s.botUa === 0 && s.ctx > 0).map(([ip]) => ip))
const rejectedReal = [...ipInfo].filter(([, s]) => s.marker > 0 && !(s.mal === 0 && s.botUa === 0 && s.ctx > 0)).length
for (const r of rows) r.type = (r.pre === 'Unknown' && realIps.has(r.ip)) ? 'Real User' : r.pre
// IP 級多數決：惡意佔比 ≥80% 且 ≥10 筆的 IP，其餘 Unknown 請求一併視為惡意（同一掃描器打 / 探路）
const ipStat = new Map()
for (const r of rows) { const s = ipStat.get(r.ip) || { n: 0, mal: 0 }; s.n++; if (r.type === 'Malicious Bot') s.mal++; ipStat.set(r.ip, s) }
let promoted = 0
for (const r of rows) { const s = ipStat.get(r.ip); if (r.type === 'Unknown' && s.n >= 10 && s.mal / s.n >= 0.8) { r.type = 'Malicious Bot'; promoted++ } }

const cnt = (arr, key) => { const m = new Map(); for (const x of arr) { const k = key(x); m.set(k, (m.get(k) || 0) + 1) } return [...m].sort((a, b) => b[1] - a[1]) }
const pct = (n, d) => (100 * n / d).toFixed(1) + '%'
const esc = (s) => String(s).replace(/\|/g, '\\|')
const N = rows.length
const out = []
const P = (s = '') => out.push(s)
const table = (hdr, body) => { P('| ' + hdr.join(' | ') + ' |'); P('|' + hdr.map(() => '---').join('|') + '|'); for (const b of body) P('| ' + b.map(esc).join(' | ') + ' |'); P() }
const toTW = (r) => new Date(new Date(`${r.date}T${r.time}Z`).getTime() + 8 * 3600 * 1000)
const fmtTW = (r) => toTW(r).toISOString().replace('T', ' ').slice(0, 19)

const sorted = [...rows].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
P('## 4.1 總覽'); P()
table(['項目', '值'], [
  ['時間區間', `${fmtTW(sorted[0])} ~ ${fmtTW(sorted.at(-1))} (台灣時間)`],
  ['總請求數', N.toLocaleString()],
  ['唯一 IP', new Set(rows.map(r => r.ip)).size.toLocaleString()],
  ['總回應流量', (rows.reduce((s, r) => s + r.bytes, 0) / 1048576).toFixed(1) + ' MB'],
  ['真實使用者 IP（依 bundle/入口 API 判定）', realIps.size],
  ['載過 bundle 但因同 IP 有惡意／bot 請求或無站內脈絡而剔除的 IP', rejectedReal],
  ['IP 多數決升級為惡意的請求', promoted],
])
P('## 4.2 狀態碼分布'); P()
table(['狀態', '筆數', '%'], cnt(rows, r => r.status).map(([k, v]) => [k, v.toLocaleString(), pct(v, N)]))
P('## 4.3 協定分布'); P()
table(['協定', '筆數', '%', '真人筆數'], cnt(rows, r => r.protocol).map(([k, v]) => [k, v.toLocaleString(), pct(v, N), rows.filter(r => r.protocol === k && r.type === 'Real User').length]))
P('## 4.4 流量分類'); P()
table(['類型', '請求數', '%', '唯一 IP', '流量 MB'], TYPES.map(t => { const rs = rows.filter(r => r.type === t); return [t, rs.length.toLocaleString(), pct(rs.length, N), new Set(rs.map(r => r.ip)).size, (rs.reduce((s, r) => s + r.bytes, 0) / 1048576).toFixed(1)] }))
P('### 4.4a 各類代表 UA（前 6）'); P()
for (const t of ['Search Engine', 'AI Bot', 'Social Preview', 'Malicious Bot', 'Unknown', 'Internal']) {
  P(`**${t}**`); P()
  table(['UA', '筆數', 'IP 數'], cnt(rows.filter(r => r.type === t), r => r.ua.slice(0, 110)).slice(0, 6).map(([k, v]) => [k, v, new Set(rows.filter(r => r.type === t && r.ua.slice(0, 110) === k).map(r => r.ip)).size]))
}
P('### 4.4b 惡意流量 Top 25 路徑'); P()
table(['路徑', '筆數', '狀態碼分布'], cnt(rows.filter(r => r.type === 'Malicious Bot'), r => r.uri).slice(0, 25).map(([k, v]) => [k, v, cnt(rows.filter(r => r.type === 'Malicious Bot' && r.uri === k), r => r.status).map(([s, c]) => `${s}×${c}`).join(' ')]))

P('## 4.5 Top 25 IP'); P()
const byIp = cnt(rows, r => r.ip).slice(0, 25)
table(['#', 'IP', '國家', '請求', 'Edge', '主要類型', '樣本路徑'], byIp.map(([ip, v], i) => {
  const rs = rows.filter(r => r.ip === ip)
  return [i + 1, ip, rs[0].cc, v, cnt(rs, r => r.edge.slice(0, 3))[0][0], cnt(rs, r => r.type)[0][0], cnt(rs, r => r.uri).slice(0, 3).map(([p]) => p.slice(0, 40)).join(', ')]
}))
P('## 4.6a 全流量國家分布 (Top 15)'); P()
table(['#', '國家', '請求', '%', 'IP 數', '惡意%'], cnt(rows, r => r.cc).slice(0, 15).map(([k, v], i) => { const rs = rows.filter(r => r.cc === k); return [i + 1, k, v.toLocaleString(), pct(v, N), new Set(rs.map(r => r.ip)).size, pct(rs.filter(r => r.type === 'Malicious Bot').length, v)] }))
P('## 4.6b 真實使用者國家分布'); P()
const realRows = rows.filter(r => r.type === 'Real User')
table(['#', '國家', '唯一 IP', '請求'], cnt(realRows, r => r.cc).map(([k, v]) => [0, k, new Set(realRows.filter(r => r.cc === k).map(r => r.ip)).size, v]).sort((a, b) => b[2] - a[2]).map((row, i) => { row[0] = i + 1; return row }))
P('## 4.7 真實使用者流量'); P()
P('**SPA 路由（https 200/304，真人）**'); P()
const routeKey = (u) => u.replace(/^\/(clothes|discography)\/.+/, '/$1/:id')
table(['路由', '次數', 'IP 數'], cnt(realRows.filter(r => SPA_ROUTE.test(r.uri) && (r.status === '200' || r.status === '304')), r => routeKey(r.uri)).map(([k, v]) => [k, v, new Set(realRows.filter(r => routeKey(r.uri) === k && SPA_ROUTE.test(r.uri)).map(r => r.ip)).size]))
P('**API / 資料層（真人）**'); P()
table(['路徑', '次數', 'Hit/RefreshHit', 'Miss'], cnt(realRows.filter(r => /^\/(api|data)\//.test(r.uri)), r => r.uri.replace(/\?.*/, '')).slice(0, 15).map(([k, v]) => { const rs = realRows.filter(r => r.uri.replace(/\?.*/, '') === k); return [k, v, rs.filter(r => /Hit/.test(r.resultType)).length, rs.filter(r => r.resultType === 'Miss').length] }))
P('**靜態資產（真人）**'); P()
table(['資產', '次數'], cnt(realRows.filter(r => /^\/assets\//.test(r.uri)), r => r.uri.replace(/-[A-Za-z0-9_-]{8}\.(js|css)$/, '-HASH.$1')).slice(0, 12).map(([k, v]) => [k, v]))
P('**Edge 節點分布（真人）**'); P()
table(['Edge', '次數', 'IP 數'], cnt(realRows, r => r.edge.slice(0, 3)).map(([k, v]) => [k, v, new Set(realRows.filter(r => r.edge.slice(0, 3) === k).map(r => r.ip)).size]))
P('**每日真實使用者（唯一 IP）**'); P()
table(['日期 (台灣)', '真人 IP', '真人請求', 'Unknown IP', '惡意請求', '合計'], cnt(rows, r => fmtTW(r).slice(0, 10)).sort((a, b) => a[0].localeCompare(b[0])).map(([d]) => { const rs = rows.filter(r => fmtTW(r).slice(0, 10) === d); return [d, new Set(rs.filter(r => r.type === 'Real User').map(r => r.ip)).size, rs.filter(r => r.type === 'Real User').length, new Set(rs.filter(r => r.type === 'Unknown').map(r => r.ip)).size, rs.filter(r => r.type === 'Malicious Bot').length, rs.length] }))
P('**真人 UA 類型（作業系統粗分）**'); P()
const osOf = (ua) => /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other'
table(['OS', 'IP 數', '請求'], cnt(realRows, r => osOf(r.ua)).map(([k, v]) => [k, new Set(realRows.filter(r => osOf(r.ua) === k).map(r => r.ip)).size, v]))
P('**Referer（真人，站外）**'); P()
table(['Referer', '次數'], cnt(realRows.filter(r => r.referer !== '-' && !/m-b\.win/.test(r.referer)), r => r.referer.replace(/^(https?:\/\/[^\/]+).*/, '$1')).slice(0, 10).map(([k, v]) => [k, v]))

P('## 4.8 快取效率'); P()
table(['Result Type', '筆數', '%', '真人筆數'], cnt(rows, r => r.resultType).map(([k, v]) => [k, v.toLocaleString(), pct(v, N), realRows.filter(r => r.resultType === k).length]))
P('**細部結果（x-edge-detailed-result-type）**'); P()
table(['Detailed', '筆數'], cnt(rows, r => r.detailed).map(([k, v]) => [k, v.toLocaleString()]))

P('## 4.9 BotBlockerFunction 效果'); P()
const mal = rows.filter(r => r.type === 'Malicious Bot')
table(['類別', '筆數', '說明'], [
  ['惡意 → 404（Function 擋下）', mal.filter(r => r.status === '404').length, 'Function 生效'],
  ['惡意 → 301（HTTP 先被轉址）', mal.filter(r => r.status === '301').length, 'bot 走 HTTP，轉址前就結束'],
  ['惡意 → 403（S3 origin 拒絕）', mal.filter(r => r.status === '403').length, '路徑不在 bucket／目錄型路徑'],
  ['惡意 → 200（穿透）', mal.filter(r => r.status === '200').length, '理想為 0，見下表'],
  ['惡意 → 其他', mal.filter(r => !['404', '301', '403', '200'].includes(r.status)).length, '000/307 等'],
])
P('**惡意類拿到 200 的路徑**'); P()
table(['路徑', '筆數', 'UA 摘要'], cnt(mal.filter(r => r.status === '200'), r => r.uri).slice(0, 20).map(([k, v]) => [k, v, cnt(mal.filter(r => r.status === '200' && r.uri === k), r => r.ua.slice(0, 50))[0][0]]))
P('**403 路徑 Top 15（S3 拒絕而非 Function 擋）**'); P()
table(['路徑', '筆數', '類型'], cnt(rows.filter(r => r.status === '403'), r => r.uri).slice(0, 15).map(([k, v]) => [k, v, cnt(rows.filter(r => r.status === '403' && r.uri === k), r => r.type)[0][0]]))

P('## 4.10 每小時流量（台灣時間）'); P()
const hours = Array.from({ length: 24 }, (_, h) => h)
table(['時', '真人', 'Unknown', '搜尋/AI/社群', '惡意', 'Internal', '合計'], hours.map(h => { const rs = rows.filter(r => toTW(r).getUTCHours() === h); return [String(h).padStart(2, '0'), rs.filter(r => r.type === 'Real User').length, rs.filter(r => r.type === 'Unknown').length, rs.filter(r => ['Search Engine', 'AI Bot', 'Social Preview'].includes(r.type)).length, rs.filter(r => r.type === 'Malicious Bot').length, rs.filter(r => r.type === 'Internal').length, rs.length] }))

P('## 附錄 A：惡意流量 Top 15 IP'); P()
table(['IP', '國家', '請求', 'UA 摘要', '主要路徑'], cnt(mal, r => r.ip).slice(0, 15).map(([ip, v]) => { const rs = mal.filter(r => r.ip === ip); return [ip, rs[0].cc, v, cnt(rs, r => r.ua.slice(0, 45))[0][0], cnt(rs, r => r.uri.slice(0, 35))[0][0]] }))
P('**惡意流量依 UA 家族**'); P()
const malFam = (ua) => ua === '-' ? '(空 UA)' : (ua.match(MAL_UA) || [null])[0]?.toLowerCase() || (ua.match(AI_UA) || [null])[0]?.toLowerCase() || (/Chrome\/120\.0\.0\.0 Safari/.test(ua) ? 'Chrome/120 固定 UA（Azure 掃描器）' : /EdgA\/148/.test(ua) ? 'EdgA/148 固定 UA' : /Go-http-client/.test(ua) ? 'Go-http-client' : /WordPress\//.test(ua) ? 'WordPress pingback' : /python|curl|wget|java|okhttp/i.test(ua) ? 'script (python/curl/…)' : '其他瀏覽器型 UA')
table(['UA 家族', '筆數', 'IP 數', '國家 Top3'], cnt(mal, r => malFam(r.ua)).map(([k, v]) => { const rs = mal.filter(r => malFam(r.ua) === k); return [k, v, new Set(rs.map(r => r.ip)).size, cnt(rs, r => r.cc).slice(0, 3).map(([c, n]) => `${c}:${n}`).join(' ')] }))
P('## 附錄 B：Unknown 類 Top 15 UA / Top 12 路徑'); P()
const unk = rows.filter(r => r.type === 'Unknown')
table(['UA', '筆數', 'IP 數', '主要路徑'], cnt(unk, r => r.ua.slice(0, 90)).slice(0, 15).map(([k, v]) => [k, v, new Set(unk.filter(r => r.ua.slice(0, 90) === k).map(r => r.ip)).size, cnt(unk.filter(r => r.ua.slice(0, 90) === k), r => r.uri.slice(0, 30))[0][0]]))
table(['路徑', '筆數', 'IP 數'], cnt(unk, r => r.uri).slice(0, 12).map(([k, v]) => [k, v, new Set(unk.filter(r => r.uri === k).map(r => r.ip)).size]))
P('## 附錄 C：Internal（開發／自家自動化）組成'); P()
const intr = rows.filter(r => r.type === 'Internal')
const cond = (name, fn) => [name, intr.filter(fn).length, new Set(intr.filter(fn).map(r => r.ip)).size]
table(['來源', '筆數', 'IP 數'], [
  cond('自家 IP（IPv6 前綴＋指定 IPv4）', r => INTERNAL_PREFIXES.some(p => r.ip.startsWith(p))),
  cond('UA=node（CI／snapshot 腳本）', r => r.ua === 'node'),
  cond('referer localhost（vite dev）', r => /localhost:\d+/.test(r.referer)),
  cond('Claude 桌面 app 預覽', r => /Claude\/1\.\d+.*Electron/.test(r.ua)),
  cond('curl', r => /^curl/.test(r.ua)),
  cond('HeadlessChrome', r => /HeadlessChrome/.test(r.ua)),
  cond('FeedFetcher-Google 打 /webhook/youtube（PubSubHubbub）', r => r.uri === '/webhook/youtube'),
  cond('AWS 東京排程函式打 `/api/streamlist?limit=3`（每 10 分鐘，來源待確認）', r => r.ua === 'node' && r.cc === 'JP' && /^\/api\/streamlist/.test(r.uri)),
])
P('## 附錄 F：真實使用者 IP 清單（供人工核對）'); P()
table(['IP', '國家', 'Edge', '請求', '天數', 'SPA 路由', '主要路徑', 'UA 摘要'], [...realIps].map(ip => { const rs = rows.filter(r => r.ip === ip); return [ip, rs[0].cc, cnt(rs, r => r.edge.slice(0, 3))[0][0], rs.length, new Set(rs.map(r => r.date)).size, rs.filter(r => SPA_ROUTE.test(r.uri) && (r.status === '200' || r.status === '304')).map(r => routeKey(r.uri)).filter((v, i, a) => a.indexOf(v) === i).join(' '), cnt(rs, r => r.uri.replace(/\?.*/, '').slice(0, 32))[0][0], cnt(rs, r => r.ua.slice(0, 60))[0][0]] }).sort((a, b) => b[3] - a[3]))
table(['Internal Top 路徑', '筆數'], cnt(intr, r => r.uri.replace(/\?.*/, '')).slice(0, 10).map(([k, v]) => [k, v]))
P('## 附錄 D：AI / 搜尋 / 社群 bot 細分'); P()
const fam = (r) => (r.ua.match(SEARCH_UA) || r.ua.match(AI_UA) || r.ua.match(SOCIAL_UA) || ['?'])[0].toLowerCase()
table(['類型', 'UA 家族', '筆數', 'IP 數', '200', '403/404', '主要路徑'], ['Search Engine', 'AI Bot', 'Social Preview'].flatMap(t => cnt(rows.filter(r => r.type === t), fam).map(([k, v]) => { const rs = rows.filter(r => r.type === t && fam(r) === k); return [t, k, v, new Set(rs.map(r => r.ip)).size, rs.filter(r => r.status === '200').length, rs.filter(r => r.status === '403' || r.status === '404').length, cnt(rs, r => r.uri.slice(0, 30))[0][0]] })))
P('**Bot 打到惡意路徑而被歸為 Malicious 的「白名單 UA」筆數**（UA 掛 bot 名但行為是掃描）'); P()
table(['UA 家族', '筆數', 'IP 數', '主要路徑'], cnt(mal.filter(r => SEARCH_UA.test(r.ua) || AI_UA.test(r.ua) || SOCIAL_UA.test(r.ua)), fam).map(([k, v]) => { const rs = mal.filter(r => fam(r) === k); return [k, v, new Set(rs.map(r => r.ip)).size, cnt(rs, r => r.uri.slice(0, 35)).slice(0, 2).map(([p]) => p).join(', ')] }))
P('## 附錄 E：OG 預覽／社群分享相關'); P()
table(['項目', '筆數'], [
  ['/og/ 路徑直接請求', rows.filter(r => r.uri.startsWith('/og/')).length],
  ['/img/og/ 卡片圖請求', rows.filter(r => /^\/img\/og\//.test(r.uri)).length],
  ['t.co / x.com / twitter referer', rows.filter(r => /t\.co|twitter\.com|x\.com/.test(r.referer)).length],
  ['discord referer 或 UA', rows.filter(r => /discord/i.test(r.referer + r.ua)).length],
  ['/clothes/:id 或 /discography/:id 命中', rows.filter(r => /^\/(clothes|discography)\/[^\/]+$/.test(r.uri)).length],
  ['/robots.txt', rows.filter(r => r.uri === '/robots.txt').length],
  ['/sitemap.xml', rows.filter(r => r.uri === '/sitemap.xml').length],
])
P('**縮圖 /tb/ 請求**'); P()
const tb = rows.filter(r => r.uri.startsWith('/tb/'))
table(['項目', '值'], [['總筆數', tb.length], ['真人筆數', tb.filter(r => r.type === 'Real User').length], ['Hit 率', pct(tb.filter(r => /Hit/.test(r.resultType)).length, tb.length || 1)], ['404 筆數', tb.filter(r => r.status === '404').length]])
console.log(out.join('\n'))
