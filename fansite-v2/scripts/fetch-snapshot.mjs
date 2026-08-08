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
// 單檔失敗只跳過不中斷；逐月之間 sleep 200ms 禮貌節流。

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

/** 抓一支端點並寫檔；失敗只記錄不中斷 */
async function snapshot(file, pathname, transform) {
  try {
    const data = await fetchJson(pathname)
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
  total += await snapshot('songlist.json', '/api/songlist')
  total += await snapshot('streamlist.json', '/api/streamlist')
  total += await snapshot('yt-latest.json', '/api/yt/latest')

  // 現站靜態檔（沿革頁 / 首頁最近更新）——原樣快照，避免 runtime 打線上站
  total += await snapshotRaw('history.md', '/pages/history.md')
  total += await snapshotRaw('changelog.json', '/changelog.json')

  // manifest：月份清單 + 指紋（前端首訪拿它當初始 fingerprints）
  let manifest = null
  try {
    manifest = await fetchJson('/api/setlist/manifest')
  } catch (err) {
    failures++
    console.warn(`  ✗ manifest.json 失敗：${err.message}`)
  }

  const wantedMonthFiles = new Set()

  if (manifest && Array.isArray(manifest.months)) {
    total += await writeJson('manifest.json', { ...manifest, fetchedAt: new Date().toISOString() })

    console.log(`[snapshot] 逐月抓 setlist（${manifest.months.length} 個 bucket）…`)
    for (const entry of manifest.months) {
      const month = entry.month
      const file = month === 'none' ? 'setlist-none.json' : `setlist-${month}.json`
      const query =
        month === 'none' ? '/api/setlist?from=none&to=none' : `/api/setlist?from=${month}&to=${month}`
      wantedMonthFiles.add(file)
      total += await snapshot(file, query)
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
