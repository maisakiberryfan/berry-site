/**
 * CDN 快照 cron —— 重產前端的 /data/*.json 並寫入 S3（可多站台）
 *
 * 觸發：EventBridge Schedule，Input `{"source":"snapshot"}` → entry-lambda.js 分流。
 * 資料來源：Hono `app.request()` 內部調用自家 API（零網路來回、與前端拿到的
 *   完全同一份輸出）。格式基準是 `fansite-v2/scripts/fetch-snapshot.mjs`（v3）與
 *   `scripts/fetch-snapshot.mjs`（v2 現站，CI 版）——**檔名／信封解包／清理邏輯三處必須同步**。
 *
 * 產物（S3 key 一律 `data/<file>`，內容是解包後的 data）：
 *   songlist.json / streamlist.json / yt-latest.json
 *   manifest.json（額外加 fetchedAt）
 *   setlist-{YYYY-MM}.json / setlist-none.json（依 manifest 逐月）
 *   history.md / changelog.json（現站靜態檔，非 API，走 HTTP 抓）
 *   ※ 後三者（yt-latest/history/changelog）是 v3 才用的；寫進 v2 現站 bucket 只是
 *     幾 KB 的無害多餘檔（且會被現站 CI 的 `sync --delete` 清掉、下輪 cron 再補）。
 *
 * 為什麼要 cron：快照原本只在部署時產（CI `npm run snapshot`），資料更新後就過期。
 *   前端有 API 背景校正兜底，所以快照「不必永遠新鮮」——但首訪體感差，故定期重產。
 *
 * 目標站台：環境變數 `SNAPSHOT_TARGETS`，格式 `bucket:distributionId,bucket2:distributionId2`
 *   （distributionId 可省略＝不發 invalidation）。**未設＝整個步驟 skip 並 log**，
 *   未配置此功能的環境完全不受影響。
 *
 * 失效策略：每個 target 全部寫完後發 **一次** invalidation `/data/*`（1 path）。
 *   物件 CacheControl 固定 `public, max-age=300`，與現站 CI 的快照 sync 一致
 *   （invalidation 管不到瀏覽器快取，短 max-age 才是瀏覽器端的收斂手段）。
 *
 * 失敗語意：單檔失敗不中斷（照 fetch-snapshot.mjs 的 failures 模式）——舊物件留在 S3
 *   比缺檔安全；只有「manifest 失敗」或「某個 target 一個檔都沒寫成」才算整體失敗。
 */

import app from '../app.js'
import { getSecret } from '../platform.js'

// 前端以 `/data/<file>` 取用（fansite-v2/src/api/client.js、現站 assets/js 快照層）
const KEY_PREFIX = 'data/'
// 帶完整 URL 呼叫 app.request() 可跳過 Hono 的 mergePath，query string 原樣保留
const INTERNAL_ORIGIN = 'http://localhost'
// history.md / changelog.json 只存在於現站 S3（不是 API），故走 HTTP。
// ⚠️ 新站切換後若這兩支路徑消失，fetch 失敗＝保留 S3 舊檔，不致命（可用
//    SNAPSHOT_STATIC_BASE 改來源）
const STATIC_BASE_DEFAULT = 'https://m-b.win'
const STATIC_TIMEOUT_MS = 20_000
// 逐月查詢之間的節流：DB 在記憶體吃緊的 VPS 上，避免 70+ 連發塞滿
const THROTTLE_MS = 50
// S3 併發寫入數（內部 API 調用序列化——Lambda 共用單一 DB 連線，併發無益）
const PUT_CONCURRENCY = 6
// 與現站 CI 的 `aws s3 sync fansite/data/ --cache-control` 逐字一致
const CACHE_CONTROL = 'public, max-age=300'

const CONTENT_TYPE = {
  json: 'application/json',
  md: 'text/markdown; charset=utf-8',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let s3Client = null
let cfClient = null

async function getS3Client() {
  if (!s3Client) {
    const { S3Client } = await import('@aws-sdk/client-s3')
    s3Client = new S3Client({})
  }
  return s3Client
}

async function getCfClient() {
  if (!cfClient) {
    const { CloudFrontClient } = await import('@aws-sdk/client-cloudfront')
    cfClient = new CloudFrontClient({})
  }
  return cfClient
}

/**
 * 解析 `SNAPSHOT_TARGETS`：`bucket:dist,bucket2:dist2`（dist 可省略）。
 * template.yaml 以 !Sub 由多組 Parameter 拼字串，未設定的組會留下 `:` 這種空段——
 * bucket 為空的段一律丟棄，故「參數留白＝該站台不處理」。
 */
export function parseTargets(raw) {
  const seen = new Set()
  return String(raw || '')
    .split(',')
    .map((seg) => {
      const i = seg.indexOf(':')
      return {
        bucket: (i === -1 ? seg : seg.slice(0, i)).trim(),
        distributionId: (i === -1 ? '' : seg.slice(i + 1)).trim(),
      }
    })
    .filter((t) => {
      if (!t.bucket || seen.has(t.bucket)) return false
      seen.add(t.bucket)
      return true
    })
}

/** 內部調用自家 API 並解包信封（{data} / {success,data} / ad-hoc），與 fetch-snapshot.mjs 同構 */
async function internalJson(pathname, env) {
  const res = await app.request(
    `${INTERNAL_ORIGIN}${pathname}`,
    { headers: { Accept: 'application/json' } },
    env
  )
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${pathname}`)
  const body = await res.json()
  if (body && typeof body === 'object' && body.success === false) {
    throw new Error(`API error — ${pathname}: ${JSON.stringify(body.error)}`)
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && 'data' in body) return body.data
  return body
}

/** 原樣抓現站靜態檔（不解信封、不重新序列化） */
async function fetchStatic(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(STATIC_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`)
  const text = await res.text()
  if (!text.trim()) throw new Error(`空內容 — ${url}`)
  return text
}

/** 併發寫入單一 bucket（單檔失敗只記錄）；回傳成功筆數 */
async function putAll(bucket, files, failures) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3')
  const client = await getS3Client()

  let uploaded = 0
  let cursor = 0

  const worker = async () => {
    while (cursor < files.length) {
      const item = files[cursor++]
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: KEY_PREFIX + item.file,
          Body: item.body,
          ContentType: item.contentType,
          CacheControl: CACHE_CONTROL,
        }))
        uploaded++
      } catch (err) {
        failures.push(`${bucket} put ${item.file}: ${err.message}`)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PUT_CONCURRENCY, files.length) }, () => worker())
  )
  return uploaded
}

/**
 * 清掉 manifest 已不存在的舊月份檔（避免 bucket 累積死檔）。
 * 只碰 `data/setlist-*.json`，其餘物件一律不動。
 */
async function cleanupStaleMonths(bucket, wantedFiles, failures) {
  const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3')
  const client = await getS3Client()

  const stale = []
  let token
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${KEY_PREFIX}setlist-`,
      ContinuationToken: token,
    }))
    for (const obj of page.Contents || []) {
      const file = obj.Key.slice(KEY_PREFIX.length)
      if (!/^setlist-.+\.json$/.test(file)) continue
      if (wantedFiles.has(file)) continue
      stale.push({ Key: obj.Key })
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)

  if (!stale.length) return 0

  let deleted = 0
  for (let i = 0; i < stale.length; i += 1000) {   // DeleteObjects 單批上限 1000
    const batch = stale.slice(i, i + 1000)
    const res = await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch, Quiet: true },
    }))
    for (const e of res.Errors || []) failures.push(`${bucket} delete ${e.Key}: ${e.Message}`)
    deleted += batch.length - (res.Errors?.length || 0)
  }
  console.log(`[SNAPSHOT] ${bucket} 移除過期月份檔 ${deleted} 個：${stale.map((o) => o.Key).join(', ')}`)
  return deleted
}

/** 一次 invalidation 清掉整個 /data/*（1 path；免費額度 1000/月）。失敗不致命 */
async function invalidateData(distributionId) {
  const { CreateInvalidationCommand } = await import('@aws-sdk/client-cloudfront')
  const client = await getCfClient()
  await client.send(new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: {
      CallerReference: `snapshot-${Date.now()}`,
      Paths: { Quantity: 1, Items: ['/data/*'] },
    },
  }))
}

/**
 * 重產快照並寫入所有目標 bucket。
 * @param {Object} env - 環境（Lambda 傳 {}，實際值由 platform.js 落到 process.env）
 * @returns {Promise<Object>} 執行摘要
 */
export async function runSnapshot(env = {}) {
  const startedAt = Date.now()

  const targets = parseTargets(getSecret(env, 'SNAPSHOT_TARGETS'))
  if (!targets.length) {
    console.log('[SNAPSHOT] SNAPSHOT_TARGETS 未設定，跳過快照更新')
    return { ok: true, skipped: true, reason: 'SNAPSHOT_TARGETS not configured' }
  }

  const staticBase = (getSecret(env, 'SNAPSHOT_STATIC_BASE') || STATIC_BASE_DEFAULT)
    .replace(/\/+$/, '')

  const failures = []
  const files = []          // { file, body, contentType }——抓一次，寫進所有 target
  const wantedMonthFiles = new Set()
  let manifestOk = false

  /** 內部 API → JSON 字串，收進待寫清單 */
  const collectApi = async (file, pathname, transform) => {
    try {
      const data = await internalJson(pathname, env)
      const value = transform ? transform(data) : data
      files.push({ file, body: JSON.stringify(value), contentType: CONTENT_TYPE.json })
      return value
    } catch (err) {
      failures.push(`${file}: ${err.message}`)
      return null
    }
  }

  /** 現站靜態檔 → 原樣字串，收進待寫清單 */
  const collectStatic = async (file, pathname, contentType) => {
    try {
      files.push({ file, body: await fetchStatic(staticBase + pathname), contentType })
    } catch (err) {
      failures.push(`${file}: ${err.message}`)
    }
  }

  console.log(`[SNAPSHOT] 開始（targets=${targets.map((t) => t.bucket).join(', ')}，static=${staticBase}）`)

  await collectApi('songlist.json', '/api/songlist')
  await collectApi('streamlist.json', '/api/streamlist')
  await collectApi('yt-latest.json', '/api/yt/latest')

  await collectStatic('history.md', '/pages/history.md', CONTENT_TYPE.md)
  await collectStatic('changelog.json', '/changelog.json', CONTENT_TYPE.json)

  // manifest：月份清單 + 指紋（前端首訪拿它當初始 fingerprints）
  const manifest = await collectApi('manifest.json', '/api/setlist/manifest', (data) => ({
    ...data,
    fetchedAt: new Date().toISOString(),
  }))

  if (manifest && Array.isArray(manifest.months)) {
    manifestOk = true
    console.log(`[SNAPSHOT] 逐月抓 setlist（${manifest.months.length} 個 bucket）…`)
    for (const entry of manifest.months) {
      const month = entry.month
      // month 會拼進 S3 key，只收 YYYY-MM 或 none（regex 同後端 monthStart()）。
      // 現況不可利用（month 由 DATE_FORMAT 生成，字元集僅數字與 -），純縱深防禦。
      if (month !== 'none' && !/^\d{4}-\d{2}$/.test(month)) {
        failures.push(`manifest month 格式非法，已跳過: ${month}`)
        continue
      }
      const file = month === 'none' ? 'setlist-none.json' : `setlist-${month}.json`
      const query = month === 'none'
        ? '/api/setlist?from=none&to=none'
        : `/api/setlist?from=${month}&to=${month}`
      // 先登記再抓：抓失敗的月份保留 S3 舊檔，不被下方清理誤刪
      wantedMonthFiles.add(file)
      await collectApi(file, query)
      if (THROTTLE_MS) await sleep(THROTTLE_MS)
    }
  }

  const fetchedMs = Date.now() - startedAt

  // 逐 target 寫入：單一站台出錯（bucket 名錯／權限缺）不影響其他站台
  const results = []
  for (const target of targets) {
    const { bucket, distributionId } = target
    const result = { bucket, uploaded: 0, deleted: 0, invalidated: false }
    try {
      result.uploaded = await putAll(bucket, files, failures)

      // 清理的兩個前提：manifest 成功（wanted 清單可信）＋這輪至少寫成功一個檔
      // （一個都沒寫成＝bucket 名錯／權限缺／S3 出事，此時只刪不寫是最糟的組合）
      if (manifestOk && wantedMonthFiles.size && result.uploaded > 0) {
        result.deleted = await cleanupStaleMonths(bucket, wantedMonthFiles, failures)
      }

      // 有東西寫進去才值得清 edge
      if (distributionId && (result.uploaded > 0 || result.deleted > 0)) {
        try {
          await invalidateData(distributionId)
          result.invalidated = true
        } catch (err) {
          // 非致命：S3 已是新內容，edge 快取過期後自然生效
          failures.push(`${bucket} invalidation(${distributionId}): ${err.message}`)
        }
      } else if (!distributionId) {
        console.log(`[SNAPSHOT] ${bucket} 未指定 distributionId，略過 CloudFront invalidation`)
      }
    } catch (err) {
      failures.push(`${bucket}: ${err.message}`)
    }
    console.log(`[SNAPSHOT] ${bucket} → 寫入 ${result.uploaded}/${files.length}、` +
      `清理 ${result.deleted}、${result.invalidated ? '已' : '未'}invalidate`)
    results.push(result)
  }

  const ok = manifestOk && results.length > 0 && results.every((r) => r.uploaded > 0)
  const summary = {
    ok,
    skipped: false,
    files: files.length,
    months: wantedMonthFiles.size,
    targets: results,
    failures,
    fetchedMs,
    durationMs: Date.now() - startedAt,
  }

  const line = `[SNAPSHOT] 完成 ${files.length} 檔 × ${results.length} 站台，` +
    `抓取 ${(fetchedMs / 1000).toFixed(1)}s／總計 ${(summary.durationMs / 1000).toFixed(1)}s`
  if (ok && !failures.length) console.log(line)
  else if (ok) console.warn(`${line}；${failures.length} 項失敗：${failures.join(' | ')}`)
  else console.error(`${line}；整體失敗：${failures.join(' | ') || 'no files uploaded'}`)

  return summary
}
