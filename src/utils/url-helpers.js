/**
 * @fileoverview URL processing utilities for YouTube video handling
 */

/**
 * Extract video ID from YouTube URL
 * Supports various YouTube URL formats including Shorts, Live, and standard videos
 * @param {string} url - YouTube URL
 * @returns {string|null} Video ID or null if invalid
 */
export function extractVideoId(url) {
  if (!url || typeof url !== 'string') {
    return null
  }

  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^[a-zA-Z0-9_-]{11}$/ // Direct video ID
  ]

  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) {
      return match[1] || match[0] // Handle both capture groups and direct matches
    }
  }

  return null
}

