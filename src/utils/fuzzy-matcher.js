/**
 * @fileoverview Fuzzy matching for setlist song matching
 * Delegates CPU-intensive matching to AWS Lambda (setlist-matcher)
 */

import { getSecret } from '../platform.js'

// 輸入護欄：與 lambda/setlist-matcher/src/handler.js 的 CONFIG.maxLines 同值。
// matcher 端才是真正擋得住的一道（API Gateway 對外可直接打），這裡先擋一次可省無謂的
// Lambda 呼叫；實測最長場次 raw 231 行，500 留足量體不誤傷正常歌單。
const MAX_SETLIST_LINES = 500

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

  const lines = setlistComment.split('\n')
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
