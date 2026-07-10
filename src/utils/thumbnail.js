/**
 * YouTube thumbnail download & S3 upload utility
 * Lambda 環境專用（CF Workers 跳過）
 *
 * 換圖偵測：VT 習慣先隨便放圖、之後換正式縮圖——每次呼叫都與 S3 現有圖比對
 * MD5（HeadObject ETag＝單次 PUT 的 MD5，免下載整檔），變了才重新上傳並
 * invalidate CloudFront（/tb/* 快取 7 天，不清的話訪客最長一週看舊圖）。
 */

import { getSecret } from '../platform.js'

let s3Client = null
let cfClient = null

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
 * @returns {Promise<boolean>} true if uploaded (new or changed), false if skipped/unchanged
 */
export async function saveThumbnail(streamID, env) {
  // CF Workers 環境跳過
  const isLambda = typeof process !== 'undefined' && !globalThis.caches
  if (!isLambda) return false

  const bucket = getSecret(env, 'THUMBNAIL_BUCKET')
  if (!bucket) return false

  const url = `https://i.ytimg.com/vi/${streamID}/mqdefault.jpg`
  const res = await fetch(url)
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
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    if (head.ETag?.replaceAll('"', '') === newMd5) return false
  } catch { /* 不存在（404）→ 首次上傳 */ }

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: new Uint8Array(body),
    ContentType: 'image/jpeg',
    CacheControl: 'public, max-age=604800'
  }))

  await invalidateThumbnail(streamID, env)
  return true
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
