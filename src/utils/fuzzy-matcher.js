/**
 * @fileoverview Fuzzy matching for setlist song matching
 * Delegates CPU-intensive matching to AWS Lambda (setlist-matcher)
 */

import { getSecret } from '../platform.js'

// 輸入護欄：與 lambda/setlist-matcher/src/handler.js 的 CONFIG.maxLines/maxLineChars/
// maxTotalChars 同值。matcher 端才是真正擋得住的一道（API Gateway 對外可直接打），
// 這裡先擋一次可省無謂的 Lambda 呼叫；實測最長場次 raw 231 行、留言約 10KB，
// 500 行 / 單行 1000 字 / 總長 200KB 留足量體不誤傷正常歌單。
// 字元數上限是必要的：fuzzy 比對對單行長度是二次方成長，只算行數擋不住單行巨量輸入
const MAX_SETLIST_LINES = 500
const MAX_SETLIST_LINE_CHARS = 1000
const MAX_SETLIST_TOTAL_CHARS = 200_000

/**
 * Fuzzy match setlist comment against songlist database via Lambda
 * @param {string} setlistComment - Raw setlist comment text
 * @param {Object} env - Worker environment bindings
 * @returns {Promise<Object>} { songIDs: Array, matches: Array }
 */
export async function fuzzyMatchSetlist(setlistComment, env) {
  const lambdaUrl = getSecret(env, 'LAMBDA_MATCHER_URL')

  if (!lambdaUrl) {
    throw new Error('LAMBDA_MATCHER_URL is not configured')
  }

  if (typeof setlistComment !== 'string' || !setlistComment) {
    throw new Error('setlistComment 必須是非空字串')
  }

  // 字元數超限＝異常輸入（正常歌單留言不會有 1000 字的單行），與 matcher 端一致直接拒絕；
  // 截斷會把一行砍成半句、比對結果更難追查
  if (setlistComment.length > MAX_SETLIST_TOTAL_CHARS) {
    console.warn(`[MATCHER] setlistComment 總長 ${setlistComment.length} 超過上限 ${MAX_SETLIST_TOTAL_CHARS}，拒絕解析`)
    throw new Error(`setlistComment 總長超過上限（${setlistComment.length} > ${MAX_SETLIST_TOTAL_CHARS}）`)
  }

  const lines = setlistComment.split('\n')

  const longLineIndex = lines.findIndex(line => line.length > MAX_SETLIST_LINE_CHARS)
  if (longLineIndex !== -1) {
    console.warn(`[MATCHER] setlistComment 第 ${longLineIndex + 1} 行長度 ${lines[longLineIndex].length} 超過上限 ${MAX_SETLIST_LINE_CHARS}，拒絕解析`)
    throw new Error(`setlistComment 第 ${longLineIndex + 1} 行長度超過上限（${lines[longLineIndex].length} > ${MAX_SETLIST_LINE_CHARS}）`)
  }

  if (lines.length > MAX_SETLIST_LINES) {
    console.warn(`[MATCHER] setlistComment 行數 ${lines.length} 超過上限 ${MAX_SETLIST_LINES}，截斷處理`)
    setlistComment = lines.slice(0, MAX_SETLIST_LINES).join('\n')
  }

  const response = await fetch(lambdaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setlistComment })
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText)
    throw new Error(`Lambda API error: ${response.status} - ${errorText}`)
  }

  const result = await response.json()

  if (!result.success) {
    throw new Error(result.error?.message || 'Lambda returned error')
  }

  return result
}
