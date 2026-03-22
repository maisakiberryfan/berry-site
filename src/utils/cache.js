// Cache management utilities for Hyperdrive API

/**
 * Generate ETag based on content hash
 * Uses SHA-256 hash of serialized data
 *
 * @param {Array} rows - Array of data rows
 * @returns {Promise<string>} ETag value (e.g., "a1b2c3d4")
 */
export async function generateETag(rows) {
  if (!rows || rows.length === 0) {
    // Empty dataset - use current timestamp
    return `"${Date.now().toString(36)}"`
  }

  // Serialize full row data for accurate change detection
  const content = JSON.stringify(rows)

  // Calculate SHA-256 hash
  const msgUint8 = new TextEncoder().encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

  // Use first 8 characters (same length as current ETag)
  return `"${hashHex.substring(0, 8)}"`
}

/**
 * Check if client ETag matches cached ETag
 *
 * @param {string} clientETag - ETag from If-None-Match header
 * @param {string} serverETag - Current ETag
 * @returns {boolean} True if match
 */
export function checkETagMatch(clientETag, serverETag) {
  if (!clientETag || !serverETag) return false

  // Normalize ETags (remove W/ prefix if present)
  const normalizeETag = (etag) => etag.replace(/^W\//, '').trim()

  return normalizeETag(clientETag) === normalizeETag(serverETag)
}

/**
 * Cache configuration constants
 */
export const CACHE_CONFIG = {
  // Cache keys
  KEYS: {
    SONGLIST: 'cache:songlist:v1',
    STREAMLIST: 'cache:streamlist:v1',
    SETLIST: 'cache:setlist:v1'
  },

  // TTL values (seconds)
  TTL: {
    DEFAULT: 86400,      // 24 hours
    SHORT: 3600,         // 1 hour
    LONG: 604800         // 7 days
  },

  // Cache-Control headers
  HEADERS: {
    // For GET requests - cacheable with revalidation
    CACHEABLE: 'public, max-age=0, must-revalidate',  // Force revalidate each request

    // For POST/PUT/DELETE - never cache
    NO_CACHE: 'no-cache, no-store, must-revalidate',

    // For 304 responses
    NOT_MODIFIED: 'public, max-age=0, must-revalidate'
  }
}
