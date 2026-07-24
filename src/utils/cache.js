// Cache management utilities for Hyperdrive API

/**
 * Meta ETag：以表的 COUNT(*) + MAX(updatedAt) 生成輕量指紋，
 * 讓 304 路徑完全跳過全量查詢（setlist 實測 2.7s → ~0.8s）。
 *
 * 正確性前提（2026-07-24 已於 production DB 實測，scripts/verify-timestamp-semantics.cjs）：
 * 三表 updatedAt 均為 ON UPDATE CURRENT_TIMESTAMP(6)——任何欄位值真的變更即自動刷新、
 * 設相同值不刷新；COUNT 補「刪 row 不動 MAX」的盲點。
 *
 * ⚠️ ETAG_VERSION 紀律：metadata 指紋偵測不到「資料沒動但輸出變了」的代碼層變更。
 * 任何改變 API 輸出形狀的修改（setlist VIEW 定義、SELECT 欄位增減、格式轉換），
 * 都必須 bump 對應版本，否則帶舊 ETag 的客戶端會一直拿 304 看不到新格式。
 */
export const ETAG_VERSION = {
  setlist: 'v1',
  songlist: 'v1',
  streamlist: 'v1',
}

// FNV-1a 32-bit（同步、零依賴；用途是相鄰狀態的變更偵測，碰撞率 2^-32 足夠）
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * @param {string} version - ETAG_VERSION 對應項
 * @param {object} meta - counts + max timestamps（dateStrings 字串，序列化穩定）
 * @returns {string} ETag，如 "mv1-1a2b3c4d"
 */
export function generateMetaETag(version, meta) {
  return `"m${version}-${fnv1a(JSON.stringify(meta))}"`
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
