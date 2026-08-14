#!/usr/bin/env node
// 從正式 API 抓「CDN 快照」到 public/data/ —— 首訪三層瀑布的第二層。
//
//   npm run snapshot                       # 預設 https://m-b.win
//   BERRY_API=http://localhost:8788 npm run snapshot
//
// 全部是唯讀 GET。產物（存的是解包後的 data）：
//   songlist.json            /api/songlist 全量
//   streamlist.json          /api/streamlist 全量
//   manifest.json            /api/setlist/manifest（額外加 fetchedAt 欄位）
//   setlist-{YYYY-MM}.json   依 manifest 逐月抓 /api/setlist?from=M&to=M
//   setlist-none.json        不留檔場 bucket（from=none&to=none）
//   yt-latest.json           /api/yt/latest
//   history.md               現站靜態沿革（history-bot 維護）— 原樣存檔
//   changelog.json           現站更新紀錄 — 原樣存檔
//
// 後兩者是現站的「靜態檔」而非 API，來源固定走 STATIC_BASE（預設 https://m-b.win，
// 可用 BERRY_STATIC 覆寫）——把它們納入快照後，前端不必再繞 vite proxy 打線上站。
//
// 失敗語意：單檔失敗不中斷（其餘檔案照產），但整支以 exit code 1 結束——CI 據此
// 判斷「這批快照不完整」，跳過同步／不覆蓋線上既有的完整快照（AWS 側的
// `aws s3 sync --delete` 尤其依賴這點：壞快照若靜默 exit 0，S3 的 /data/ 會被清空）。
// 逐月之間 sleep 200ms 禮貌節流。

import { mkdir, writeFile, readdir, unlink, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = (process.env.BERRY_API || 'https://m-b.win').replace(/\/+$/, '')
// 靜態檔（history.md / changelog.json）不隨 BERRY_API 走本地 API server——它們只存在於現站
const STATIC_BASE = (process.env.BERRY_STATIC || 'https://m-b.win').replace(/\/+$/, '')
const OUT_DIR = fileURLToPath(new URL('../public/data/', import.meta.url))
const THROTTLE_MS = 200
const TIMEOUT_MS = 60_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0

/** 抓 JSON 並解包信封（{data} / {success,data} / ad-hoc） */
async function fetchJson(pathname) {
  const url = BASE + pathname
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`)
  const body = await res.json()
  if (body && typeof body === 'object' && body.success === false) {
    throw new Error(`API error — ${url}: ${JSON.stringify(body.error)}`)
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && 'data' in body) return body.data
  return body
}

async function writeJson(file, value) {
  const target = path.join(OUT_DIR, file)
  await writeFile(target, JSON.stringify(value), 'utf8')
  const { size } = await stat(target)
  const count = Array.isArray(value) ? ` ${value.length} 筆` : ''
  console.log(`  ✓ ${file.padEnd(26)} ${fmtSize(size).padStart(9)}${count}`)
  return size
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * 抓一支端點並寫檔；失敗只記錄不中斷（最後以 exit code 反映）
 * @param {Object} [opts]
 * @param {boolean} [opts.expectArray] 形狀防呆：前端一律以 Array.isArray 驗收，這裡先擋掉
 *   （例如 SPA fallback 回 HTML、或端點改了信封）——寧可少一個檔讓前端走 API，
 *   也不要寫出前端讀不懂的快照
 * @param {Function} [opts.transform] 寫檔前的轉換
 */
async function snapshot(file, pathname, { expectArray = false, transform } = {}) {
  try {
    const data = await fetchJson(pathname)
    if (expectArray && !Array.isArray(data)) {
      throw new Error(`回應不是陣列（${data === null ? 'null' : typeof data}）`)
    }
    return await writeJson(file, transform ? transform(data) : data)
  } catch (err) {
    failures++
    console.warn(`  ✗ ${file} 失敗：${err.message}`)
    return 0
  }
}

/** 原樣抓現站靜態檔（不解信封、不重新序列化）；失敗只記錄不中斷 */
async function snapshotRaw(file, pathname) {
  const url = STATIC_BASE + pathname
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`)
    const text = await res.text()
    if (!text.trim()) throw new Error(`空內容 — ${url}`)
    const target = path.join(OUT_DIR, file)
    await writeFile(target, text, 'utf8')
    const { size } = await stat(target)
    console.log(`  ✓ ${file.padEnd(26)} ${fmtSize(size).padStart(9)}`)
    return size
  } catch (err) {
    failures++
    console.warn(`  ✗ ${file} 失敗：${err.message}`)
    return 0
  }
}

async function main() {
  console.log(`[snapshot] 來源 ${BASE}`)
  await mkdir(OUT_DIR, { recursive: true })

  let total = 0
  total += await snapshot('songlist.json', '/api/songlist', { expectArray: true })
  total += await snapshot('streamlist.json', '/api/streamlist', { expectArray: true })
  total += await snapshot('yt-latest.json', '/api/yt/latest')   // 單一物件，不驗陣列

  // 現站靜態檔（沿革頁 / 首頁最近更新）——原樣快照，避免 runtime 打線上站
  total += await snapshotRaw('history.md', '/pages/history.md')
  total += await snapshotRaw('changelog.json', '/changelog.json')

  // manifest：月份清單 + 指紋（前端首訪拿它當初始 fingerprints）
  // 形狀不對＝這批快照不可信：必須計入 failures（exit 1），否則 CI 會拿一份「只有
  // songlist/streamlist、沒有任何月度檔」的快照去 sync --delete，把 S3 的月度快照清空
  let manifest = null
  try {
    manifest = await fetchJson('/api/setlist/manifest')
    if (!manifest || !Array.isArray(manifest.months)) throw new Error('缺少 months 陣列')
  } catch (err) {
    manifest = null
    failures++
    console.warn(`  ✗ manifest.json 失敗：${err.message}`)
  }

  const wantedMonthFiles = new Set()

  if (manifest) {
    total += await writeJson('manifest.json', { ...manifest, fetchedAt: new Date().toISOString() })

    console.log(`[snapshot] 逐月抓 setlist（${manifest.months.length} 個 bucket）…`)
    for (const entry of manifest.months) {
      const month = entry.month
      // month 會拼進寫檔路徑，只收 YYYY-MM 或 none（regex 同後端 monthStart()）。
      // 現況不可利用（month 由 DATE_FORMAT 生成，字元集僅數字與 -），純縱深防禦。
      if (month !== 'none' && !/^\d{4}-\d{2}$/.test(month)) {
        failures++
        console.warn(`  ✗ manifest month 格式非法，已跳過：${month}`)
        continue
      }
      const file = month === 'none' ? 'setlist-none.json' : `setlist-${month}.json`
      const query =
        month === 'none' ? '/api/setlist?from=none&to=none' : `/api/setlist?from=${month}&to=${month}`
      wantedMonthFiles.add(file)
      total += await snapshot(file, query, { expectArray: true })
      await sleep(THROTTLE_MS)
    }
  }

  // 清掉 manifest 已不存在的舊月份檔（避免 dist 累積死檔）
  if (wantedMonthFiles.size) {
    const existing = await readdir(OUT_DIR)
    for (const file of existing) {
      if (!/^setlist-.+\.json$/.test(file) || wantedMonthFiles.has(file)) continue
      await unlink(path.join(OUT_DIR, file))
      console.log(`  – 移除過期快照 ${file}`)
    }
  }

  console.log(`[snapshot] 完成，總計 ${fmtSize(total)}${failures ? `，${failures} 個檔失敗` : ''}`)
  if (failures) process.exitCode = 1
}

main().catch((err) => {
  console.error('[snapshot] 中止：', err)
  process.exit(1)
})
