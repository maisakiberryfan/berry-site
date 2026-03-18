/**
 * @fileoverview Fuzzy matching for setlist song matching
 * Delegates CPU-intensive matching to AWS Lambda (setlist-matcher)
 */

import { getSecret } from '../platform.js'

/**
 * Fuzzy match setlist comment against songlist database via Lambda
 * @param {string} setlistComment - Raw setlist comment text
 * @param {Object} songlistData - Songlist data (unused, Lambda fetches its own)
 * @param {Object} env - Worker environment bindings
 * @returns {Promise<Object>} { songIDs: Array, matches: Array }
 */
export async function fuzzyMatchSetlist(setlistComment, songlistData, env) {
  const lambdaUrl = getSecret(env, 'LAMBDA_MATCHER_URL')

  if (!lambdaUrl) {
    throw new Error('LAMBDA_MATCHER_URL is not configured')
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
