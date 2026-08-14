/**
 * YouTube thumbnail download & S3 upload utility
 * Lambda 環境專用（CF Workers 跳過）
 *
 * 換圖偵測：VT 習慣先隨便放圖、之後換正式縮圖——每次呼叫都與 S3 現有圖比對
 * MD5（HeadObject ETag＝單次 PUT 的 MD5，免下載整檔），變了才重新上傳並
 * invalidate CloudFront（/tb/* 快取 7 天，不清的話訪客最長一週看舊圖）。
 *
 * 批次模式（`{ defer: true }`）：換圖的 path 先累積在模組層，由呼叫端在整批跑完後
 * 呼叫 flushThumbnailInvalidations() 發**一次** `/tb/*` invalidation。近 14 天兜底重刷
 * 一輪可能有十幾支換圖，逐支各發一次會把免費額度（1000 path/月）當柴燒。
 */

import { getSecret } from '../platform.js'

// 縮圖下載逾時：i.ytimg.com 正常 <1s，8s 已寬鬆；沒有 timeout 的話一支卡住的下載
// 會把整輪 cron（近 14 天兜底重刷跑十幾支）吊到 Lambda 被砍
const THUMBNAIL_TIMEOUT_MS = 8_000

let s3Client = null
let cfClient = null

// defer 模式累積的換圖 streamID（module scope 在 warm Lambda 跨 invocation 存活；
// 上一輪沒 flush 到的會併進下一輪，最差只是晚一輪清快取）
const pendingInvalidations = new Set()

async function getS3Client() {
  if (s3Client) return s3Client
  const { S3Client } = await import('@aws-sdk/client-s3').catch(() => ({}))
  s3Client = new S3Client({})
  return s3Client
}

async function getCfClient() {
  if (cfClient) return cfClient
  const { CloudFrontClient } = await import('@aws-sdk/client-cloudfront').catch(() => ({}))
  cfClient = new CloudFrontClient({})
  return cfClient
}

/**
 * Download YouTube thumbnail and upload to S3 (only when changed)
 * @param {string} streamID - YouTube video ID
 * @param {Object} env - Environment variables
 * @param {Object} [options]
 * @param {boolean} [options.defer] - 換圖後不立刻 invalidate，累積到 flushThumbnailInvalidations()
 * @returns {Promise<boolean>} true if uploaded (new or changed), false if skipped/unchanged
 */
export async function saveThumbnail(streamID, env, { defer = false } = {}) {
  // CF Workers 環境跳過
  const isLambda = typeof process !== 'undefined' && !globalThis.caches
  if (!isLambda) return false

  const bucket = getSecret(env, 'THUMBNAIL_BUCKET')
  if (!bucket) return false

  const url = `https://i.ytimg.com/vi/${streamID}/mqdefault.jpg`
  const res = await fetch(url, { signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS) })
  if (!res.ok) return false

  const body = await res.arrayBuffer()

  // YouTube 預設佔位圖約 1-2KB，正常縮圖 > 5KB
  if (body.byteLength < 5000) return false

  const { PutObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3').catch(() => ({}))
  const client = await getS3Client()
  const key = `tb/${streamID}.jpg`

  // 與現有圖比對 MD5（ETag）：未變更就不重傳、不 invalidate
  const { createHash } = await import('node:crypto')
  const newMd5 = createHash('md5').update(new Uint8Array(body)).digest('hex')
  let head = null
  try {
    head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  } catch (err) {
    // 只有「物件不存在」才是首次上傳。權限缺／限流／5xx 也走這個 catch，
    // 當成首傳的話會每輪重傳整批縮圖（近 14 天兜底一輪十幾支）並連發 invalidation
    const code = err?.name || err?.Code || err?.code
    const status = err?.$metadata?.httpStatusCode
    const notFound = code === 'NotFound' || code === 'NoSuchKey' || status === 404
    if (!notFound) {
      console.warn(`[THUMBNAIL] HeadObject 失敗（跳過本支，非首傳）: ${streamID} - ${code || err?.message}`)
      return false
    }
  }
  if (head?.ETag?.replaceAll('"', '') === newMd5) return false

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: new Uint8Array(body),
    ContentType: 'image/jpeg',
    CacheControl: 'public, max-age=604800'
  }))

  if (defer) {
    pendingInvalidations.add(streamID)
    console.log(`[THUMBNAIL] 縮圖已更新（invalidation 延後批次處理）: ${streamID}`)
  } else {
    await invalidateThumbnail(streamID, env)
  }
  return true
}

/**
 * 把 defer 模式累積的換圖一次清掉：發**一支** `/tb/*` invalidation（1 path）。
 * 逐支各發一次在批次重刷時會吃掉大量免費額度，且每支都是一次 CloudFront API 往返。
 * 失敗不拋出——S3 已是新圖，邊緣快取過期（7 天）後自然生效。
 * @returns {Promise<number>} 這次清掉的換圖支數（0＝沒有待處理）
 */
export async function flushThumbnailInvalidations(env) {
  if (pendingInvalidations.size === 0) return 0

  const count = pendingInvalidations.size
  const distributionId = getSecret(env, 'CLOUDFRONT_DISTRIBUTION_ID')
  if (!distributionId) {
    pendingInvalidations.clear()
    return 0
  }

  try {
    const { CreateInvalidationCommand } = await import('@aws-sdk/client-cloudfront').catch(() => ({}))
    const client = await getCfClient()
    await client.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: `tb-batch-${Date.now()}`,
        Paths: { Quantity: 1, Items: ['/tb/*'] }
      }
    }))
    // 送出成功才清空：失敗就留著併進下一輪（縮圖遲一輪清快取不致命，漏清才是問題）
    pendingInvalidations.clear()
    console.log(`[THUMBNAIL] ${count} 支換圖，已發一次 /tb/* invalidation`)
    return count
  } catch (e) {
    console.warn(`[THUMBNAIL] 批次 invalidation 失敗（非致命，下輪重試）: ${count} 支 - ${e.message}`)
    return 0
  }
}

/**
 * 換圖後清 CloudFront edge 快取（免費額度每月 1000 path，此處用量 <50/月）。
 * 失敗不拋出——縮圖延遲更新非致命，S3 已是新圖、快取過期後自然生效。
 */
async function invalidateThumbnail(streamID, env) {
  const distributionId = getSecret(env, 'CLOUDFRONT_DISTRIBUTION_ID')
  if (!distributionId) return

  try {
    const { CreateInvalidationCommand } = await import('@aws-sdk/client-cloudfront').catch(() => ({}))
    const client = await getCfClient()
    await client.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: `tb-${streamID}-${Date.now()}`,
        Paths: { Quantity: 1, Items: [`/tb/${streamID}.jpg`] }
      }
    }))
    console.log(`[THUMBNAIL] 縮圖已更新並清除快取: ${streamID}`)
  } catch (e) {
    console.warn(`[THUMBNAIL] CloudFront invalidation 失敗（非致命）: ${streamID} - ${e.message}`)
  }
}
