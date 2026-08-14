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
 *   比缺檔安全；只有「manifest 失敗」「時間預算用盡」或「某個 target 一個檔都沒寫成」
 *   才算整體失敗（ok=false）。ok=false 一律發 Discord 通知——cron 沒有人在看
 *   CloudWatch，靜默失敗等於快照永遠停在某個舊版本卻沒人知道。
 */

import app from '../app.js'
import { getSecret } from '../platform.js'
import { sendDiscordNotification } from '../utils/discord-notifier.js'

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
// 逐月抓取的時間預算：月份只增不減，總量會單調成長，總有一天撞上 Lambda Timeout（180s）。
// 被 timeout 中砍＝連 S3 都沒寫、也沒有任何摘要或通知；主動在 120s 收手則能寫完
// 手上的檔、發出 ok=false 通知（剩下的月份下一輪 cron 或前端 API 校正會補上）
const FETCH_BUDGET_MS = 120_000
// manifest 是 commit point，必須最後寫入（見 putAll）
const MANIFEST_FILE = 'manifest.json'

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
 *
 * 去重的 key 是 `bucket:distributionId` 而非只有 bucket：同一 bucket 掛在兩個
 * distribution（主站＋備用／demo）是合法配置，用 bucket 當 key 會靜默吃掉第二個
 * distribution 的 invalidation。真正完全相同的段才丟棄，且丟棄時 warn。
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
      if (!t.bucket) return false
      const key = `${t.bucket}:${t.distributionId}`
      if (seen.has(key)) {
        console.warn(`[SNAPSHOT] SNAPSHOT_TARGETS 有完全重複的目標，已略過：${key}`)
        return false
      }
      seen.add(key)
      return true
    })
}

/** manifest 的 month → 快照檔名；格式非法回 null（month 會拼進 S3 key，純縱深防禦） */
function monthFile(month) {
  if (month === 'none') return 'setlist-none.json'
  // regex 同後端 monthStart()；現況不可利用（month 由 DATE_FORMAT 生成，字元集僅數字與 -）
  if (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)) return `setlist-${month}.json`
  return null
}

/** 內部調用自家 API 並解包信封（{data} / {success,data} / ad-hoc），與 fetch-snapshot.mjs 同構 */
async function internalJson(pathname, env) {
  const res = await app.request(
    `${INTERNAL_ORIGIN}${pathname}`,
    { headers: { Accept: 'application/json' } },
    env
  )
  if (!res.ok) {
    // 附上回應 body 的錯誤訊息：只有狀態碼的話，「DB 連不上」與「路由打錯」長得一樣。
    // ⚠️ 路由層自己 catch 的錯誤（多數 GET）本來就回泛化字串，這裡最多拿到
    //    "Database operation failed"（真實原因在該路由的 console.error → CloudWatch）；
    //    走 app.js onError 的未捕例外才吐真訊息，且需 MODE=dev/test——見 runSnapshot 的 apiEnv
    let detail = ''
    try {
      const body = await res.json()
      detail = body?.error?.message || body?.error?.code || ''
    } catch { /* 非 JSON body（502 HTML 等）：只留狀態碼 */ }
    throw new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ''} — ${pathname}`)
  }
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

/** 併發寫入一批物件到單一 bucket（單檔失敗只記錄）；回傳成功筆數 */
async function putBatch(bucket, files, failures) {
  if (!files.length) return 0
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
 * 寫入單一 bucket。**manifest.json 一定最後寫**——它是這批快照的 commit point：
 * 前端拿 manifest 當初始 fingerprints，「新 manifest ＋ 尚未更新的月度檔」會讓指紋
 * 對得上卻讀到舊資料（前端不會察覺、不會重抓）；反過來「舊 manifest ＋ 新月度檔」
 * 只是多一輪 API 校正。Lambda 被 timeout 中砍或 S3 中途出錯時，後者才是安全的中間態。
 * 併發池（PUT_CONCURRENCY）內的完成順序不保證，故拆成兩批依序 await，而非只排在陣列尾端。
 */
async function putAll(bucket, files, failures) {
  const manifestItems = files.filter((f) => f.file === MANIFEST_FILE)
  const rest = files.filter((f) => f.file !== MANIFEST_FILE)

  let uploaded = await putBatch(bucket, rest, failures)
  uploaded += await putBatch(bucket, manifestItems, failures)
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

  // 內部調用專用 env：app.js 的 onError 只在 `c.env.MODE` 為 dev/test 時把真實錯誤放進
  // 回應（正式環境一律泛化，不外洩 DB 細節）。Lambda 上 env 是 {}（真值全在 process.env）
  // ⇒ 不帶 MODE 的話 cron 連未捕例外都只看到 "Internal server error"，failures 與
  // Discord 通知沒有診斷價值。這是 server 內部調用，回應不外流（只進 CloudWatch／通知），
  // 故明確帶值；其餘欄位沿用傳入 env（CF 路徑的 bindings 不受影響）。
  // 注意上限：路由層自己 catch 的錯誤回的就是泛化字串，MODE 幫不上忙（見 internalJson）。
  const apiEnv = { ...env, MODE: 'dev' }

  const failures = []
  const files = []          // { file, body, contentType }——抓一次，寫進所有 target
  const wantedMonthFiles = new Set()
  let manifestOk = false
  let budgetExceeded = false

  /** 內部 API → JSON 字串，收進待寫清單 */
  const collectApi = async (file, pathname, transform) => {
    try {
      const data = await internalJson(pathname, apiEnv)
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
    const months = manifest.months
    for (let i = 0; i < months.length; i++) {
      const month = months[i]?.month
      const file = monthFile(month)
      if (!file) {
        failures.push(`manifest month 格式非法，已跳過: ${month}`)
        continue
      }

      // 時間預算：月份只增不減，遲早撞上 Lambda Timeout。主動收手才有機會寫出手上的檔
      // 並發通知；被 timeout 中砍則是什麼都沒有。剩餘月份仍登記進 wanted 清單——
      // 否則下方清理會把它們在 S3 上的舊檔當成「manifest 已不存在」誤刪
      if (Date.now() - startedAt > FETCH_BUDGET_MS) {
        budgetExceeded = true
        for (const rest of months.slice(i)) {
          const f = monthFile(rest?.month)
          if (f) wantedMonthFiles.add(f)
        }
        const msg = `時間預算 ${FETCH_BUDGET_MS / 1000}s 用盡，剩餘 ${months.length - i} 個月份未更新`
        failures.push(msg)
        console.warn(`[SNAPSHOT] ${msg}`)
        break
      }

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

  // 時間預算中止＝這批不完整，manifest 不 commit（保留 S3 上的舊 manifest）：
  // 新 manifest 配上「這輪沒更新到」的月度檔，前端會指紋對上卻讀到舊資料且不自癒；
  // 舊 manifest 則讓既有的 API 比對照常把變更月份抓回來
  const uploadFiles = budgetExceeded ? files.filter((f) => f.file !== MANIFEST_FILE) : files

  // 逐 target 寫入：單一站台出錯（bucket 名錯／權限缺）不影響其他站台
  const results = []
  for (const target of targets) {
    const { bucket, distributionId } = target
    const result = { bucket, uploaded: 0, deleted: 0, invalidated: false }
    try {
      result.uploaded = await putAll(bucket, uploadFiles, failures)

      // 清理的兩個前提：manifest 成功（wanted 清單可信）＋這輪至少寫成功一個檔
      // （一個都沒寫成＝bucket 名錯／權限缺／S3 出事，此時只刪不寫是最糟的組合）
      // 自帶 try/catch：清理（List/DeleteObjects）拋錯不該連帶跳過下面的 invalidation，
      // 檔案已經寫進去了，edge 沒清＝使用者拿到舊快照
      if (manifestOk && wantedMonthFiles.size && result.uploaded > 0) {
        try {
          result.deleted = await cleanupStaleMonths(bucket, wantedMonthFiles, failures)
        } catch (err) {
          failures.push(`${bucket} cleanup: ${err.message}`)
        }
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
    console.log(`[SNAPSHOT] ${bucket} → 寫入 ${result.uploaded}/${uploadFiles.length}、` +
      `清理 ${result.deleted}、${result.invalidated ? '已' : '未'}invalidate`)
    results.push(result)
  }

  const ok = manifestOk && !budgetExceeded && results.length > 0 &&
    results.every((r) => r.uploaded > 0)
  const summary = {
    ok,
    skipped: false,
    budgetExceeded,
    files: uploadFiles.length,
    months: wantedMonthFiles.size,
    targets: results,
    failures,
    fetchedMs,
    durationMs: Date.now() - startedAt,
  }

  const line = `[SNAPSHOT] 完成 ${uploadFiles.length} 檔 × ${results.length} 站台，` +
    `抓取 ${(fetchedMs / 1000).toFixed(1)}s／總計 ${(summary.durationMs / 1000).toFixed(1)}s`
  if (ok && !failures.length) console.log(line)
  else if (ok) console.warn(`${line}；${failures.length} 項失敗：${failures.join(' | ')}`)
  else console.error(`${line}；整體失敗：${failures.join(' | ') || 'no files uploaded'}`)

  // 整體失敗才通知：cron 沒人盯 CloudWatch，靜默＝快照停在舊版本卻沒人知道。
  // 部分失敗（ok=true）不發——單檔失敗有舊物件兜底，發了只會變成雜訊被無視。
  // 通知本身失敗不得影響 cron 結果（sendDiscordNotification 內部已吞例外，這裡再包一層）
  if (!ok) {
    try {
      await sendDiscordNotification(env, { type: 'snapshot', success: false, summary })
    } catch (err) {
      console.error('[SNAPSHOT] Discord 通知失敗（不影響 cron 結果）:', err?.message || err)
    }
  }

  return summary
}
