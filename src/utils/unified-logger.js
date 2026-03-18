/**
 * @fileoverview Unified Logger - 統一日誌系統
 *
 * 特性:
 * - 統一 JSON 格式（相容 Axiom/CloudWatch）
 * - Correlation ID 跨服務追蹤
 * - API 呼叫自動追蹤（target, status, duration）
 * - 錯誤時記錄 request/response 詳情
 */

// 全域 logger 實例
let loggerInstance = null

/**
 * 統一日誌類別
 */
export class UnifiedLogger {
  constructor(env) {
    this.env = env
    this.svc = 'worker'
    this.cid = null  // Correlation ID
    this.sid = this.generateSessionId()
    this.logs = []
    this.startTime = Date.now()
    this.isTestMode = env?.MODE === 'test'
    this.pendingUpload = false
  }

  /**
   * 生成 Session ID
   * 格式: YYYYMMDD-HHMM-xxxx
   */
  generateSessionId() {
    const now = new Date()
    const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const randomPart = Math.random().toString(36).substring(2, 6)
    return `${datePart}-${timePart}-${randomPart}`
  }

  /**
   * 生成 Correlation ID
   * 格式: req_YYYYMMDD-HHMM-xxxxxx
   */
  generateCorrelationId() {
    const now = new Date()
    const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const randomPart = Math.random().toString(36).substring(2, 8)
    return `req_${datePart}-${timePart}-${randomPart}`
  }

  /**
   * 設置 Correlation ID
   */
  setCorrelationId(cid) {
    this.cid = cid
  }

  /**
   * 從 request 取得或建立 Correlation ID
   */
  getOrCreateCorrelationId(request) {
    const headerValue = request?.headers?.get?.('X-Correlation-ID')
    if (headerValue) {
      this.cid = headerValue
      return headerValue
    }
    this.cid = this.generateCorrelationId()
    return this.cid
  }

  /**
   * 取得時間戳
   */
  getTimestamp() {
    return new Date().toISOString()
  }

  /**
   * 核心日誌方法
   * @param {string} lvl - 日誌級別: DEBUG, INFO, WARN, ERROR
   * @param {string} cat - 類別: CRON, API_CALL, SETLIST, STREAM, SYSTEM
   * @param {string} msg - 訊息（中文）
   * @param {Object} ctx - 上下文資料
   */
  log(lvl, cat, msg, ctx = null) {
    const entry = {
      ts: this.getTimestamp(),
      svc: this.svc,
      cid: this.cid,
      sid: this.sid,
      lvl,
      cat,
      msg
    }

    // 根據 ctx 結構加入額外欄位
    if (ctx) {
      if (ctx.api) {
        entry.api = ctx.api
      }
      if (ctx.err) {
        entry.err = ctx.err
      }
      // 其他上下文資料
      const { api, err, ...rest } = ctx
      if (Object.keys(rest).length > 0) {
        entry.ctx = rest
      }
    }

    this.logs.push(entry)

    // Console 輸出（開發用）
    this.consoleOutput(entry)

    // 錯誤時標記需要上傳
    if (lvl === 'ERROR' || lvl === 'FATAL') {
      this.pendingUpload = true
    }
  }

  /**
   * Console 輸出格式化
   */
  consoleOutput(entry) {
    const time = entry.ts.substring(11, 19) // HH:MM:SS
    const cid = entry.cid ? entry.cid.substring(4, 16) : '------------'
    const lvl = entry.lvl.padEnd(5)
    const cat = entry.cat.padEnd(10)

    // 格式: [HH:MM:SS] [worker] [req_abc123] INFO  CRON      訊息
    let line = `[${time}] [${entry.svc}] [${cid}] ${lvl} ${cat} ${entry.msg}`

    // 加入 API 詳情
    if (entry.api) {
      const { status, duration, items } = entry.api
      if (status) line += ` (${duration}ms)`
      if (items !== undefined) line += ` items=${items}`
    }

    // 輸出
    if (entry.lvl === 'ERROR' || entry.lvl === 'FATAL') {
      console.error(line)
      if (entry.err) {
        console.error('  錯誤詳情:', JSON.stringify(entry.err, null, 2))
      }
    } else if (entry.lvl === 'WARN') {
      console.warn(line)
    } else {
      console.log(line)
    }
  }

  // 便利方法
  debug(cat, msg, ctx) { this.log('DEBUG', cat, msg, ctx) }
  info(cat, msg, ctx) { this.log('INFO', cat, msg, ctx) }
  warn(cat, msg, ctx) { this.log('WARN', cat, msg, ctx) }
  error(cat, msg, ctx) { this.log('ERROR', cat, msg, ctx) }

  /**
   * API 呼叫追蹤
   * 自動記錄請求/回應詳情和耗時
   *
   * @param {string} target - 目標服務: hyperdrive, ytid, lambda, youtube
   * @param {string} method - HTTP 方法: GET, POST, PUT, DELETE
   * @param {string} endpoint - 端點路徑
   * @param {Function} fetchFn - 實際的 fetch 函數
   * @param {Object} options - 選項
   * @returns {Promise<Response>}
   */
  async apiCall(target, method, endpoint, fetchFn, options = {}) {
    const start = Date.now()
    const { reqBody, items } = options

    // 記錄請求開始
    let reqMsg = `→ ${target} ${method} ${endpoint}`
    if (items !== undefined) reqMsg += ` (${items}項)`
    this.info('API_CALL', reqMsg)

    try {
      const response = await fetchFn()
      const duration = Date.now() - start
      const status = response.status

      if (status >= 400) {
        // 錯誤回應
        let resBody = null
        try {
          resBody = await response.clone().text()
          // 嘗試解析為 JSON
          try { resBody = JSON.parse(resBody) } catch {}
        } catch {}

        this.error('API_CALL', `← ${target} ${status} 失敗`, {
          api: { target, method, endpoint, status, duration },
          err: {
            message: `HTTP ${status}`,
            ...(reqBody && { reqBody }),
            ...(resBody && { resBody })
          }
        })
      } else {
        // 成功回應
        let resItems = undefined
        // 嘗試從 response 取得項目數量
        if (options.getItems) {
          try {
            const cloned = response.clone()
            const data = await cloned.json()
            resItems = options.getItems(data)
          } catch {}
        }

        this.info('API_CALL', `← ${target} ${status} 成功`, {
          api: {
            target,
            method,
            endpoint,
            status,
            duration,
            ...(resItems !== undefined && { items: resItems })
          }
        })
      }

      return response
    } catch (err) {
      const duration = Date.now() - start

      this.error('API_CALL', `← ${target} 網路錯誤`, {
        api: { target, method, endpoint, duration },
        err: {
          message: err.message,
          ...(reqBody && { reqBody })
        }
      })

      throw err
    }
  }

  /**
   * 開始請求（設置 Correlation ID）
   */
  startRequest(request) {
    this.getOrCreateCorrelationId(request)
    this.startTime = Date.now()
  }

  /**
   * 結束請求（觸發上傳）
   */
  async endRequest() {
    const duration = Date.now() - this.startTime
    this.info('SYSTEM', `請求完成`, { duration })
    // R2 upload removed - using CloudWatch / Cloudflare Observability instead
  }

  /**
   * 上傳日誌到 R2
   */
  async uploadToR2() {
    const bucket = this.env?.LOG_BUCKET
    if (!bucket) {
      console.warn('[Logger] R2 bucket 未配置，跳過上傳')
      return false
    }

    try {
      const now = new Date()
      const datePrefix = now.toISOString().slice(0, 10) // YYYY-MM-DD
      const filename = `worker/${datePrefix}/${this.sid}.json`

      const logData = {
        sid: this.sid,
        cid: this.cid,
        svc: this.svc,
        startTime: new Date(this.startTime).toISOString(),
        endTime: now.toISOString(),
        duration: Date.now() - this.startTime,
        logCount: this.logs.length,
        hasErrors: this.logs.some(l => l.lvl === 'ERROR' || l.lvl === 'FATAL'),
        logs: this.logs
      }

      await bucket.put(filename, JSON.stringify(logData, null, 2), {
        httpMetadata: { contentType: 'application/json' }
      })

      // 更新索引
      await this.updateIndex(bucket, filename, logData)

      console.log(`[Logger] 日誌已上傳: ${filename} (${this.logs.length} 條)`)
      return true
    } catch (err) {
      console.error('[Logger] 上傳失敗:', err.message)
      return false
    }
  }

  /**
   * 更新日誌索引
   */
  async updateIndex(bucket, filename, logData) {
    try {
      // 讀取現有索引
      let index = { logs: [], lastUpdated: null }
      try {
        const existing = await bucket.get('worker/index.json')
        if (existing) {
          index = await existing.json()
        }
      } catch {}

      // 新增索引項目
      index.logs.unshift({
        filename,
        sid: logData.sid,
        cid: logData.cid,
        startTime: logData.startTime,
        endTime: logData.endTime,
        duration: logData.duration,
        logCount: logData.logCount,
        hasErrors: logData.hasErrors
      })

      // 保留最近 100 條
      index.logs = index.logs.slice(0, 100)
      index.lastUpdated = new Date().toISOString()

      await bucket.put('worker/index.json', JSON.stringify(index, null, 2), {
        httpMetadata: { contentType: 'application/json' }
      })
    } catch (err) {
      console.error('[Logger] 更新索引失敗:', err.message)
    }
  }

  /**
   * 取得日誌摘要
   */
  getSummary() {
    const errorCount = this.logs.filter(l => l.lvl === 'ERROR' || l.lvl === 'FATAL').length
    const warnCount = this.logs.filter(l => l.lvl === 'WARN').length
    const apiCalls = this.logs.filter(l => l.cat === 'API_CALL')

    return {
      sid: this.sid,
      cid: this.cid,
      logCount: this.logs.length,
      errorCount,
      warnCount,
      apiCallCount: apiCalls.length,
      duration: Date.now() - this.startTime
    }
  }

  /**
   * 取得統計資訊（相容舊介面）
   */
  getStats() {
    const summary = this.getSummary()
    return {
      Session_ID: summary.sid,
      Correlation_ID: summary.cid,
      總日誌數: summary.logCount,
      錯誤數: summary.errorCount,
      警告數: summary.warnCount,
      API呼叫數: summary.apiCallCount,
      執行時間: summary.duration
    }
  }

  /**
   * 取得純文字日誌內容（供下載用）
   */
  getLogContent() {
    return this.logs.map(entry => {
      const time = entry.ts.substring(11, 19)
      const cid = entry.cid ? entry.cid.substring(4, 16) : '------------'
      let line = `[${time}] [${entry.svc}] [${cid}] ${entry.lvl.padEnd(5)} ${entry.cat.padEnd(10)} ${entry.msg}`
      if (entry.ctx) line += ` ${JSON.stringify(entry.ctx)}`
      if (entry.api) line += ` API: ${JSON.stringify(entry.api)}`
      if (entry.err) line += ` ERR: ${JSON.stringify(entry.err)}`
      return line
    }).join('\n')
  }

  /**
   * 強制上傳日誌（用於 Cron job 結束時）
   */
  async forceUpload() {
    // R2 upload removed - no-op
    return false
  }

  /**
   * 相容舊介面：summaryLogs 屬性
   * 返回所有 INFO/WARN/ERROR 級別的日誌
   */
  get summaryLogs() {
    return this.logs.filter(l => ['INFO', 'WARN', 'ERROR', 'FATAL'].includes(l.lvl)).map(l => ({
      logId: `${this.sid}-${l.ts}`,
      sessionId: this.sid,
      timestamp: l.ts,
      level: l.lvl,
      message: l.msg,
      data: { ...l.ctx, ...l.api, ...l.err }
    }))
  }

  /**
   * 相容舊介面：detailedLogs 屬性
   * 返回所有日誌
   */
  get detailedLogs() {
    return this.logs.map(l => ({
      logId: `${this.sid}-${l.ts}`,
      sessionId: this.sid,
      timestamp: l.ts,
      category: l.cat,
      message: l.msg,
      data: { ...l.ctx, ...l.api, ...l.err }
    }))
  }
}

/**
 * 初始化 Logger
 * @param {Object} env - 環境變數
 * @returns {UnifiedLogger}
 */
export function initLogger(env) {
  loggerInstance = new UnifiedLogger(env)
  return loggerInstance
}

/**
 * 取得 Logger 實例
 * @returns {UnifiedLogger|null}
 */
export function getLogger() {
  return loggerInstance
}

/**
 * 清除 Logger 實例
 */
export function clearLogger() {
  loggerInstance = null
}

export default UnifiedLogger
