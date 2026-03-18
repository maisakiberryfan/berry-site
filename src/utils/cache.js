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
 * Get cached data from KV
 *
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} key - Cache key
 * @returns {Promise<Object|null>} Cached data with etag, or null if not found
 */
export async function getCachedData(kv, key) {
  try {
    const cached = await kv.get(key, 'json')
    return cached // { etag: "...", data: [...] }
  } catch (error) {
    console.error(`Cache read error for key ${key}:`, error)
    return null
  }
}

/**
 * Store data in KV cache
 *
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} key - Cache key
 * @param {string} etag - ETag value
 * @param {any} data - Data to cache
 * @param {number} ttl - Time to live in seconds (default: 86400 = 24 hours)
 */
export async function setCachedData(kv, key, etag, data, ttl = 86400) {
  try {
    await kv.put(key, JSON.stringify({
      etag,
      data,
      cachedAt: new Date().toISOString()
    }), {
      expirationTtl: ttl
    })
  } catch (error) {
    console.error(`Cache write error for key ${key}:`, error)
    // Don't throw - failing to cache shouldn't break the request
  }
}

/**
 * Delete cached data
 *
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string|string[]} keys - Cache key(s) to delete
 */
export async function deleteCachedData(kv, keys) {
  try {
    const keyArray = Array.isArray(keys) ? keys : [keys]
    await Promise.all(keyArray.map(key => kv.delete(key)))
  } catch (error) {
    console.error(`Cache delete error:`, error)
    // Don't throw - failing to invalidate cache shouldn't break the request
  }
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
