// API client — 後端信封解包 / ETag / timeout / 重試
//
// 後端有三套回應信封（SPEC-api.md §0），本模組統一吃掉差異：
//   { data }                              songlist / streamlist / setlist
//   { success:true, data, count?, isNew? } aliases
//   { success:true, data }                 stats/last-updated、yt/latest
//   ad-hoc 物件                            yt / yt/newvideos / yt/live-details
// 對外一律回傳「解包後的 data」；錯誤一律 throw ApiError（帶 code / status / message）。
//
// BASE_URL 為空字串＝同源相對路徑（dev 走 vite proxy，正式部署同源）。

const BASE_URL = ''
const DEFAULT_TIMEOUT = 30_000
const READ_RETRIES = 3 // GET/HEAD：首次之外最多再試 3 次
const WRITE_RETRIES = 0 // 其餘 method：預設不重試（理由見 defaultRetriesFor）
const RETRY_BASE_DELAY = 400 // 遞增：400 / 800 / 1200ms
const SNAPSHOT_TIMEOUT = 5_000 // 靜態快照：抓不到就走 API，不值得等滿 30s

export class ApiError extends Error {
  constructor(message, opts = {}) {
    super(message || 'API request failed')
    this.name = 'ApiError'
    this.code = opts.code || 'UNKNOWN_ERROR'
    this.status = opts.status ?? 0
    if (opts.fieldErrors) this.fieldErrors = opts.fieldErrors
    if (opts.details) this.details = opts.details
    if (opts.cause) this.cause = opts.cause
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 三套信封共通：有 data 欄位就取 data，否則整個 body 回傳（ad-hoc 形狀） */
function unwrap(body) {
  if (isPlainObject(body) && 'data' in body) return body.data
  return body
}

/** 由 HTTP status + body 組出統一的 ApiError */
function toApiError(status, body, fallbackMessage) {
  let code = null
  let message = null
  let fieldErrors
  let details

  if (isPlainObject(body)) {
    const e = body.error
    if (typeof e === 'string') {
      message = e
    } else if (isPlainObject(e)) {
      code = e.code || null
      message = e.message || null
      fieldErrors = e.fieldErrors
      details = e.details
    } else if (typeof body.message === 'string') {
      message = body.message
    }
  } else if (typeof body === 'string' && body) {
    message = body
  }

  if (!code) {
    code =
      status === 404 ? 'NOT_FOUND'
      : status === 409 ? 'CONFLICT'
      : status === 400 ? 'VALIDATION_ERROR'
      : status === 429 ? 'RATE_LIMITED'
      : status >= 500 ? 'SERVER_ERROR'
      : status > 0 ? `HTTP_${status}`
      : 'NETWORK_ERROR'
  }

  return new ApiError(message || fallbackMessage || `HTTP ${status}`, {
    code,
    status,
    fieldErrors,
    details,
  })
}

/** POST /api/setlist 必帶 X-Source: user，否則後端當成 worker 自動更新（只在原值為空時生效） */
function needsUserSource(method, path) {
  return method === 'POST' && /^\/api\/setlist(\?|$)/.test(path)
}

/**
 * 預設重試次數依 method 決定 —— **寫入預設不重試**。
 *
 * ⚠️ API Gateway 的硬上限是 29s，比這裡的 30s timeout 更早到：逾時的寫入請求
 *    很可能「後端已經寫成功，只是回應沒回來」。裸 INSERT 的端點
 *    （POST /api/songlist、POST /api/streamlist）只要重試一次就多一筆重複資料，
 *    5xx 亦同（Lambda 執行到一半才炸）。
 *
 * 冪等的寫入要重試請由呼叫端顯式傳 `retries`——例如 POST /api/setlist 是
 * composite key 的 UPSERT（ON DUPLICATE KEY UPDATE），重送不會產生重複列。
 * 「這個端點冪等嗎」只有呼叫端答得出來，所以預設值取安全的一側。
 */
function defaultRetriesFor(method) {
  return method === 'GET' || method === 'HEAD' ? READ_RETRIES : WRITE_RETRIES
}

/**
 * 低階請求。回傳 { data, etag, notModified, status, raw }。
 *
 * @param {string} path      以 / 開頭的路徑，例如 '/api/songlist'
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {any}    [options.body]          物件會被 JSON.stringify（自動帶 Content-Type）
 * @param {string|null} [options.etag]     GET 時帶 If-None-Match；304 → notModified=true
 * @param {object} [options.headers]
 * @param {number} [options.timeout=30000]
 * @param {number} [options.retries]       省略＝GET/HEAD 3 次、其餘 0 次（見 defaultRetriesFor）。
 *                                         4xx 一律不重試
 * @param {AbortSignal} [options.signal]
 */
export async function request(path, options = {}) {
  const {
    method: rawMethod = 'GET',
    body,
    etag = null,
    headers: extraHeaders,
    timeout = DEFAULT_TIMEOUT,
    retries,
    signal: callerSignal,
  } = options

  const method = String(rawMethod).toUpperCase()
  const maxRetries =
    Number.isFinite(retries) && retries >= 0 ? Math.trunc(retries) : defaultRetriesFor(method)

  const url = BASE_URL + path
  const headers = { ...extraHeaders }
  let payload

  if (body !== undefined && body !== null) {
    // 所有 POST/PUT/PATCH 必帶 Content-Type，缺了後端會 500
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json'
    }
    payload = typeof body === 'string' ? body : JSON.stringify(body)
  }
  if (etag) headers['If-None-Match'] = etag
  if (needsUserSource(method, path) && !headers['X-Source']) headers['X-Source'] = 'user'

  let lastError = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_DELAY * attempt)
    if (callerSignal?.aborted) throw new ApiError('Request aborted', { code: 'ABORTED' })

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeout)
    const onCallerAbort = () => controller.abort()
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

    let res
    let text = ''
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
        // 明確繞過瀏覽器 HTTP 快取：ETag 校驗由我們自己用 If-None-Match 做
        cache: 'no-store',
      })
      // body 讀取刻意留在 try + timer 之內：
      //   · 讀 body 失敗（連線中途斷、串流被截斷）算網路錯誤，該走重試而不是往外拋
      //   · timer 若在拿到 headers 就 clear，懸掛的 body 會無上限吊著（整條瀑布卡死）
      // 304 沒有 body，跳過省一次讀取。
      if (res.status !== 304) text = await res.text()
    } catch (err) {
      lastError =
        callerSignal?.aborted ? new ApiError('Request aborted', { code: 'ABORTED', cause: err })
        : timedOut ? new ApiError(`Request timeout (${timeout}ms)`, { code: 'TIMEOUT', cause: err })
        : new ApiError('Network error', { code: 'NETWORK_ERROR', cause: err })
      if (lastError.code === 'ABORTED') throw lastError
      continue // 網路錯誤 / timeout → 重試
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }

    const responseEtag = res.headers.get('ETag')

    if (res.status === 304) {
      return { data: null, etag: responseEtag || etag, notModified: true, status: 304, raw: null }
    }

    // body 解析（204 / 空 body 容錯）
    let parsed = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (!res.ok) {
      const err = toApiError(res.status, parsed, res.statusText)
      if (res.status >= 400 && res.status < 500) throw err // 4xx 不重試
      lastError = err
      continue // 5xx 重試
    }

    // 200 但信封標記失敗（aliases / yt 群組會出現）
    if (isPlainObject(parsed) && parsed.success === false) {
      throw toApiError(res.status, parsed, 'Request failed')
    }

    return {
      data: unwrap(parsed),
      etag: responseEtag,
      notModified: false,
      status: res.status,
      raw: parsed,
    }
  }

  throw lastError || new ApiError('Request failed after retries', { code: 'NETWORK_ERROR' })
}

/**
 * GET。回傳 { data, etag, notModified }（傳 etag 進來即啟用 If-None-Match）。
 * 304 時 data 為 null，呼叫端沿用既有快取。
 */
export async function apiGet(path, options = {}) {
  const { data, etag, notModified, status, raw } = await request(path, { ...options, method: 'GET' })
  return { data, etag, notModified, status, raw }
}

/** POST → 解包後的 data。需要 count/isNew 等信封欄位時改用 request() 讀 .raw */
export async function apiPost(path, body, options = {}) {
  const res = await request(path, { ...options, method: 'POST', body })
  return res.data
}

export async function apiPut(path, body, options = {}) {
  const res = await request(path, { ...options, method: 'PUT', body })
  return res.data
}

export async function apiPatch(path, body, options = {}) {
  const res = await request(path, { ...options, method: 'PATCH', body })
  return res.data
}

export async function apiDelete(path, options = {}) {
  const res = await request(path, { ...options, method: 'DELETE' })
  return res.data
}

/** 快照的逾時 signal；環境沒有 AbortSignal.timeout 就不設限（不因此壞掉） */
function snapshotSignal() {
  try {
    return AbortSignal.timeout(SNAPSHOT_TIMEOUT)
  } catch {
    return undefined
  }
}

/**
 * /public/data/*.json 靜態快照（無信封，內容即解包後的 data）。失敗回 null，不 throw。
 *
 * ⚠️ 一定要有逾時：快照是三層瀑布的第二層，CDN 連線懸掛時沒有上限就會把「往下走 API」
 *    這條路一起卡住（首訪等於白屏）。5s 抓不到就當沒有快照，直接進 API 路徑。
 */
export async function fetchSnapshot(file) {
  try {
    const res = await fetch(`/data/${file}`, { cache: 'default', signal: snapshotSignal() })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
