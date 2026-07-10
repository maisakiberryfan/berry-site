/**
 * Lambda 回應 gzip 壓縮（僅 AWS 路徑使用）
 *
 * 背景：API Gateway HTTP API 不支援壓縮、CloudFront /api/* 掛 CachingDisabled
 * managed policy（無 Accept-Encoding 正規化）也不會代壓，導致 /api/setlist
 * ~5MB JSON 原樣傳輸。Lambda 同步回應上限 6MB：對帶 Accept-Encoding: gzip 的
 * client（所有瀏覽器）壓縮後遠低於上限；不帶該 header 的 client（如裸 curl）
 * 仍走未壓縮路徑，setlist 超過 6MB 後那類請求會失敗——屆時需改分頁或強制壓縮。
 *
 * CF Workers 路徑不需要：Cloudflare edge 對 worker 回應自動套 gzip/brotli。
 */
import { gzipSync } from 'node:zlib'

const COMPRESSIBLE_CT = /json|text|javascript|xml/i
const MIN_SIZE = 1024

/**
 * 對 hono/aws-lambda handler 的 API Gateway result 做 gzip
 * @param {object} result - { statusCode, headers, body, isBase64Encoded }
 * @param {object} event - API Gateway HTTP API v2 event（headers 為 lowercase）
 * @returns {object} 壓縮後（或原樣）的 result
 */
export function compressLambdaResult(result, event) {
  if (!result || typeof result.body !== 'string') return result
  if (result.isBase64Encoded) return result

  const acceptEncoding = event?.headers?.['accept-encoding'] || ''
  if (!/\bgzip\b/i.test(acceptEncoding)) return result

  const headers = result.headers || {}
  const contentType = headers['content-type'] || headers['Content-Type'] || ''
  if (!COMPRESSIBLE_CT.test(contentType)) return result
  if (headers['content-encoding'] || headers['Content-Encoding']) return result
  if (Buffer.byteLength(result.body) < MIN_SIZE) return result

  const gzipped = gzipSync(Buffer.from(result.body))
  // Vary 用 merge 而非覆蓋：hono/cors 對每個回應設 Vary: Origin，蓋掉會讓
  // 快取層把某一 origin 的 CORS 回應誤配給另一 origin
  const existingVary = headers['vary'] || headers['Vary']
  return {
    ...result,
    headers: {
      ...headers,
      'content-encoding': 'gzip',
      'content-length': String(gzipped.length),
      'vary': existingVary && !/\baccept-encoding\b/i.test(existingVary)
        ? `${existingVary}, Accept-Encoding` : (existingVary || 'Accept-Encoding')
    },
    body: gzipped.toString('base64'),
    isBase64Encoded: true
  }
}
