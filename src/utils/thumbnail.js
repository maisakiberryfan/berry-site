/**
 * YouTube thumbnail download & S3 upload utility
 * Lambda 環境專用（CF Workers 跳過）
 */

import { getSecret } from '../platform.js'

let s3Client = null

async function getS3Client() {
  if (s3Client) return s3Client
  const { S3Client } = await import('@aws-sdk/client-s3').catch(() => ({}))
  s3Client = new S3Client({})
  return s3Client
}

/**
 * Download YouTube thumbnail and upload to S3
 * @param {string} streamID - YouTube video ID
 * @param {Object} env - Environment variables
 * @returns {Promise<boolean>} true if uploaded, false if skipped
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

  const { PutObjectCommand } = await import('@aws-sdk/client-s3').catch(() => ({}))
  const client = await getS3Client()
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `tb/${streamID}.jpg`,
    Body: new Uint8Array(body),
    ContentType: 'image/jpeg',
    CacheControl: 'public, max-age=604800'
  }))

  return true
}

/**
 * Batch download thumbnails with concurrency control
 * @param {string[]} streamIDs - Array of video IDs
 * @param {Object} env - Environment variables
 * @param {number} concurrency - Max concurrent downloads
 * @returns {Promise<{success: number, failed: number, skipped: number}>}
 */
export async function batchSaveThumbnails(streamIDs, env, concurrency = 5) {
  const result = { success: 0, failed: 0, skipped: 0 }

  for (let i = 0; i < streamIDs.length; i += concurrency) {
    const batch = streamIDs.slice(i, i + concurrency)
    const results = await Promise.allSettled(
      batch.map(id => saveThumbnail(id, env))
    )
    for (const r of results) {
      if (r.status === 'fulfilled') {
        r.value ? result.success++ : result.skipped++
      } else {
        result.failed++
      }
    }
  }

  return result
}
