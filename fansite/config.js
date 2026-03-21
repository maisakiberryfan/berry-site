// Berry Fansite API Configuration
export const API_CONFIG = {
  // API base URL — empty string = same origin (relative path)
  // Both AWS (CloudFront) and CF (Workers) serve frontend + API on the same origin
  BASE_URL: '',

  // API endpoints
  ENDPOINTS: {
    songlist: '/api/songlist',
    songlistArtists: '/api/songlist/artists',
    streamlist: '/api/streamlist',
    setlist: '/api/setlist',
    aliases: '/api/aliases',
    aliasesGrouped: '/api/aliases/grouped',
    aliasesQuickAdd: '/api/aliases/quick-add',
    aliasesTest: '/api/aliases/test',
    aliasesBatch: '/api/aliases/batch',
    health: '/health'
  },

  // Request timeout (ms)
  TIMEOUT: 30000, // Increased to 30s for batch operations

  // Retry configuration
  RETRY: {
    attempts: 3,
    delay: 1000 // Base delay, will be multiplied by attempt number
  }
}

// ETag cache storage (in-memory)
const etagCache = new Map() // { endpoint: { etag, data } }

// API request helper with error handling, retry, and ETag support
export async function apiRequest(method, endpoint, data = null, options = {}) {
  const url = `${API_CONFIG.BASE_URL}${endpoint}`
  const methodUpper = method.toUpperCase()
  const config = {
    method: methodUpper,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  }

  // For GET requests, add If-None-Match header if ETag exists in cache
  if (methodUpper === 'GET' && etagCache.has(endpoint)) {
    const cached = etagCache.get(endpoint)
    config.headers['If-None-Match'] = cached.etag
  }

  if (data && (methodUpper === 'POST' || methodUpper === 'PUT' || methodUpper === 'PATCH')) {
    config.body = JSON.stringify(data)
  }

  let lastError = null

  // Retry logic
  for (let attempt = 1; attempt <= API_CONFIG.RETRY.attempts; attempt++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT)

      const response = await fetch(url, {
        ...config,
        cache: 'no-store', // 強制每次重驗證，配合 ETag
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      // Handle 304 Not Modified - return cached data
      if (response.status === 304) {
        const cached = etagCache.get(endpoint)
        if (cached) {
          console.log(`[ETag] 304 Not Modified for ${endpoint}, using cached data`)
          return cached.data
        }
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`)
      }

      const result = await response.json()
      const resultData = result.data || result

      // For GET requests, cache the ETag and data
      if (methodUpper === 'GET' && response.headers.has('etag')) {
        const etag = response.headers.get('etag')
        etagCache.set(endpoint, { etag, data: resultData })
        console.log(`[ETag] Cached ${endpoint} with ETag: ${etag}`)
      }

      // For mutating requests (POST/PUT/DELETE), invalidate related caches
      if (methodUpper !== 'GET') {
        invalidateCache(endpoint)
      }

      return resultData

    } catch (error) {
      lastError = error
      console.warn(`API request attempt ${attempt} failed:`, error.message)

      // Don't retry on client errors (4xx)
      if (error.message.includes('HTTP 4')) {
        break
      }

      // Wait before retrying (except on last attempt)
      if (attempt < API_CONFIG.RETRY.attempts) {
        await new Promise(resolve => setTimeout(resolve, API_CONFIG.RETRY.delay * attempt))
      }
    }
  }

  throw lastError
}

// Invalidate cache for related endpoints after mutations
function invalidateCache(endpoint) {
  if (endpoint.includes('songlist')) {
    etagCache.delete(API_CONFIG.ENDPOINTS.songlist)
    etagCache.delete(API_CONFIG.ENDPOINTS.setlist)
    console.log('[ETag] Invalidated cache: songlist, setlist')
  } else if (endpoint.includes('streamlist')) {
    etagCache.delete(API_CONFIG.ENDPOINTS.streamlist)
    etagCache.delete(API_CONFIG.ENDPOINTS.setlist)
    console.log('[ETag] Invalidated cache: streamlist, setlist')
  } else if (endpoint.includes('setlist')) {
    etagCache.delete(API_CONFIG.ENDPOINTS.setlist)
    console.log('[ETag] Invalidated cache: setlist')
  } else if (endpoint.includes('aliases')) {
    etagCache.delete(API_CONFIG.ENDPOINTS.aliases)
    etagCache.delete(API_CONFIG.ENDPOINTS.aliasesGrouped)
    console.log('[ETag] Invalidated cache: aliases')
  }
}

// Loading state management
export class LoadingManager {
  constructor() {
    this.activeRequests = new Set()
  }

  start(requestId) {
    this.activeRequests.add(requestId)
    this.updateUI()
  }

  end(requestId) {
    this.activeRequests.delete(requestId)
    this.updateUI()
  }

  updateUI() {
    const isLoading = this.activeRequests.size > 0
    const loadingElements = document.querySelectorAll('.loading-indicator')

    loadingElements.forEach(el => {
      el.style.display = isLoading ? 'inline-block' : 'none'
    })

    // Update button states
    const buttons = document.querySelectorAll('button')
    buttons.forEach(btn => {
      if (btn.dataset.disableOnLoading) {
        btn.disabled = isLoading
      }
    })
  }
}

export const loadingManager = new LoadingManager()

// Error display helper
export function showError(message, type = 'danger') {
  const alertDiv = document.createElement('div')
  alertDiv.className = `alert alert-${type} alert-dismissible fade show`
  alertDiv.innerHTML = `
    ${message}
    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
  `

  const container = document.getElementById('setTableMsg') || document.getElementById('content')
  if (container) {
    container.appendChild(alertDiv)

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      if (alertDiv.parentNode) {
        alertDiv.remove()
      }
    }, 5000)
  }
}
