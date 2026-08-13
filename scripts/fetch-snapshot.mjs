#!/usr/bin/env node
// 從正式 API 抓「CDN 靜態快照」到 fansite/data/ —— 首訪三層瀑布的第二層。
//
//   npm run snapshot                       # 預設 https://m-b.win
//   BERRY_API=http://localhost:8788 npm run snapshot
//
// 為什麼要這層：首訪（IndexedDB 無快取）原本直接打 Lambda API，一發全量要等 DB 查詢
// ＋冷啟動，setlist 更是逐月串抓。快照是部署時預先產好的靜態 JSON，由 CloudFront edge
// 直出（S3 origin），首訪先吃它把表格灌滿，再讓既有的 manifest／ETag 增量邏輯把資料
// 校正到最新——快照過時的月份會被指紋差異抓出來重抓，所以快照「不必」永遠新鮮。
//
// 全部是唯讀 GET。產物（存的是解包後的 data，與前端 `(await res.json()).data` 對齊）：
//   songlist.json            /api/songlist 全量
//   streamlist.json          /api/streamlist 全量
//   manifest.json            /api/setlist/manifest（額外加 fetchedAt 欄位，除錯用）
//   setlist-{YYYY-MM}.json   依 manifest 逐月抓 /api/setlist?from=M&to=M
//   setlist-none.json        不留檔場 bucket（from=none&to=none）
//
// 失敗語意：單檔失敗不中斷（其餘檔案照產），但整支以 exit code 1 結束——CI 據此
// 判斷「這批快照不完整」，跳過同步／不覆蓋線上既有的完整快照。
// 逐月之間 sleep 200ms 禮貌節流（避免對正式 API 造成突發負載）。

import { mkdir, writeFile, readdir, unlink, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = (process.env.BERRY_API || 'https://m-b.win').replace(/\/+$/, '')
const OUT_DIR = fileURLToPath(new URL('../fansite/data/', import.meta.url))
const THROTTLE_MS = 200
const TIMEOUT_MS = 60_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0

/** 抓 JSON 並解包信封（{data} / {success,data}） */
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

/** 抓一支端點並寫檔；失敗只記錄不中斷（最後以 exit code 反映） */
async function snapshot(file, pathname, expectArray = true) {
  try {
    const data = await fetchJson(pathname)
    // 形狀防呆：前端一律以 Array.isArray 驗收，這裡先擋掉（例如 SPA fallback 回 HTML、
    // 或端點改了信封）——寧可少一個檔讓前端走 API，也不要寫出前端讀不懂的快照
    if (expectArray && !Array.isArray(data)) {
      throw new Error(`回應不是陣列（${typeof data}）`)
    }
    return await writeJson(file, data)
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

  // manifest：月份清單 + 指紋來源（前端首訪拿它 seed fingerprints，
  // 之後與 API manifest 比對，只重抓指紋有變的月份）
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
      total += await snapshot(file, query)
      await sleep(THROTTLE_MS)
    }
  }

  // 清掉 manifest 已不存在的舊月份檔（本地重跑時避免累積死檔；
  // 線上的清除由部署腳本的 s3 sync --delete 負責）
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
