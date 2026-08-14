// Database connection utility - platform-agnostic (CF Hyperdrive / AWS Lambda)
import { createConnection } from "mysql2/promise";
import { getDbConfig } from "../platform.js";

// Module-level connection cache for Lambda warm start reuse
// （Lambda 單容器一次只處理一個請求，模組級共用安全；
//   CF Workers 同一 isolate 可「並發」處理多請求，共用連線會語句交錯、
//   transaction 互踩、觸發跨 request I/O 限制 — Hyperdrive 路徑改用 per-instance 連線）
let cachedConnection = null;

/**
 * 包裝 DB 錯誤但**保留原始錯誤身分**。
 * 舊寫法 `throw new Error(...)` 只留下訊息字串，`error.code`／`error.errno` 全部丟失 ⇒
 * 上層依賴 code 的判斷全部失效：routes/setlist.js 與 routes/streamlist.js 的
 * `error.code === "ER_DUP_ENTRY"`、app.js onError 的 `err.code?.startsWith('ER_')`
 * 分類（它們只能退而依賴訊息子字串比對）。
 */
function wrapDbError(prefix, error) {
  const e = new Error(`${prefix}: ${error.message}`);
  e.code = error.code;
  e.errno = error.errno;
  e.sqlState = error.sqlState;
  e.cause = error;
  return e;
}

/** 斷線類錯誤（可考慮重試／重建連線的唯一情形） */
function isConnectionLost(error) {
  return error?.code === 'PROTOCOL_CONNECTION_LOST' || error?.code === 'ECONNRESET';
}

/**
 * 語句前綴 → 交易邊界。呼叫端都是自家路由，寫法固定為
 * "START TRANSACTION" / "COMMIT" / "ROLLBACK"（BEGIN 一併認）。
 * @returns {'start'|'end'|null}
 */
function txBoundary(sql) {
  const head = String(sql).trimStart().slice(0, 18).toUpperCase();
  if (head.startsWith('START TRANSACTION') || head.startsWith('BEGIN')) return 'start';
  if (head.startsWith('COMMIT') || head.startsWith('ROLLBACK')) return 'end';
  return null;
}

export class Database {
  constructor(env) {
    this.env = env;
    this.dbConfig = getDbConfig(env);
    // CF（Hyperdrive）：per-instance（= per-request，實例都在請求範圍內建立）
    this.usePerInstance = !!this.dbConfig._viaHyperdrive;
    this.connection = null;
    // 交易進行中旗標（per Database 實例＝per request，兩平台共用此類別）。
    // 用途：交易中的斷線**絕不可重試**——重試會落在新連線上，該連線沒有前面那些語句、
    // 且處於 autocommit ⇒ 等於把交易中段的寫入單獨提交（原交易已隨連線死亡消失）。
    this._inTx = false;
  }

  createNewConnection() {
    return createConnection({
      host: this.dbConfig.host,
      port: this.dbConfig.port,
      user: this.dbConfig.user,
      password: this.dbConfig.password,
      database: this.dbConfig.database,
      // UTF-8 support for Japanese characters and emoji
      charset: 'utf8mb4',
      // Essential for Workers compatibility - prevents eval() usage
      disableEval: true,
      // Preserve original DATETIME strings to avoid timezone conversion
      dateStrings: true,
      // Connection timeout
      connectTimeout: 10000,
      // TLS for direct connections（Hyperdrive 路徑由 Hyperdrive 處理 TLS）：
      // - Lambda：自簽憑證 → rejectUnauthorized: false
      // - workerd（wrangler dev 直連）：TLS 兩條路都不通 —— rejectUnauthorized 選項
      //   不支援（拋錯）、啟用驗證又過不了自簽憑證（internal error），只能省略 ssl。
      //   現用 root 帳號 REQUIRE SSL 會拒連；本地要連 DB 需建立允許非 TLS 的
      //   mbdb_test 專用帳號（dev 帳號 + .dev.vars 改用之）
      ...(!this.dbConfig._viaHyperdrive && typeof globalThis.caches === 'undefined' &&
        { ssl: { rejectUnauthorized: false } }),
    });
  }

  async getConnection() {
    if (this.usePerInstance) {
      // 新建連線無須 ping；斷線由 query/execute 的 retry 處理
      if (!this.connection) {
        this.connection = await this.createNewConnection();
      }
      return this.connection;
    }

    // Lambda: reuse cached connection if alive
    if (cachedConnection) {
      try {
        // Quick ping with timeout to avoid hanging on dead connections
        await Promise.race([
          cachedConnection.ping(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 3000))
        ]);
        return cachedConnection;
      } catch {
        try { cachedConnection.destroy(); } catch {}
        cachedConnection = null;
      }
    }

    cachedConnection = await this.createNewConnection();
    return cachedConnection;
  }

  resetConnection() {
    if (this.usePerInstance) {
      try { this.connection?.destroy(); } catch {}
      this.connection = null;
    } else {
      try { cachedConnection?.destroy(); } catch {}
      cachedConnection = null;
    }
    // 連線沒了＝server 端的交易已被隱含 rollback，旗標必須跟著清掉
    this._inTx = false;
  }

  async query(sql, params = []) {
    try {
      const connection = await this.getConnection();
      const [rows] = await connection.query(sql, params);
      return Array.isArray(rows) ? rows : [rows];
    } catch (error) {
      // If connection error, clear cache and retry once
      if (isConnectionLost(error)) {
        const wasInTx = this._inTx;   // resetConnection() 會清掉旗標，先取值
        this.resetConnection();
        if (wasInTx) {
          // 交易中斷線：不重試（見 constructor 的 _inTx 說明），直接拋給呼叫端 rollback／回錯
          console.error(`Database query error (in transaction → no retry): ${error.code} ${error.message}`);
          throw wrapDbError("Database query failed", error);
        }
        console.warn(`Database connection lost (${error.code}), retrying query once`);
        try {
          const connection = await this.getConnection();
          const [rows] = await connection.query(sql, params);
          return Array.isArray(rows) ? rows : [rows];
        } catch (retryError) {
          console.error("Database query error (after retry):", retryError);
          throw wrapDbError("Database query failed", retryError);
        }
      }
      console.error("Database query error:", error);
      throw wrapDbError("Database query failed", error);
    }
  }

  async execute(sql, params = []) {
    const boundary = txBoundary(sql);
    try {
      const connection = await this.getConnection();
      const [result] = await connection.query(sql, params);
      // 旗標只在語句真的成功之後才推進（失敗的 START TRANSACTION 不算開了交易）
      if (boundary === 'start') this._inTx = true;
      else if (boundary === 'end') this._inTx = false;
      return {
        meta: { last_row_id: result.insertId, changes: result.affectedRows },
      };
    } catch (error) {
      // 寫入不自動 retry：斷線可能發生在寫入「已送達」之後，重試會重複執行
      // 非冪等語句（如計數欄位的累加）。只重置壞連線供下次請求重建
      //（resetConnection 同時清掉 _inTx——連線死了交易也沒了）。
      if (isConnectionLost(error)) {
        if (this._inTx) {
          console.warn(`Database execute failed inside transaction (${error.code}), connection reset, no retry`);
        }
        this.resetConnection();
      } else if (boundary === 'end') {
        // COMMIT/ROLLBACK 本身失敗（非斷線）：交易狀態已不可知，保守地當作結束，
        // 否則旗標會卡在 true、讓這個實例後續的 query 全部失去 retry 能力
        this._inTx = false;
      }
      console.error("Database execute error:", error);
      throw wrapDbError("Database execute failed", error);
    }
  }

  async first(sql, params = []) {
    try {
      const results = await this.query(sql, params);
      return results.length > 0 ? results[0] : null;
    } catch (error) {
      console.error("Database first error:", error);
      // query() 已包過一層（含 code/errno），這裡不可再用裸 new Error 覆蓋掉那些欄位
      throw wrapDbError("Database first failed", error);
    }
  }

  // Test connection
  async testConnection() {
    try {
      const result = await this.query("SELECT 1 as test");
      return result.length > 0;
    } catch (error) {
      console.error("Connection test failed:", error);
      return false;
    }
  }
}

// Error response helper
export function createErrorResponse(code, message, fieldErrors = null) {
  const error = { code, message };
  if (fieldErrors) {
    error.fieldErrors = fieldErrors;
  }
  return { error };
}
