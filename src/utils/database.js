// Database connection utility - platform-agnostic (CF Hyperdrive / AWS Lambda)
import { createConnection } from "mysql2/promise";
import { getDbConfig } from "../platform.js";

// Module-level connection cache for Lambda warm start reuse
// （Lambda 單容器一次只處理一個請求，模組級共用安全；
//   CF Workers 同一 isolate 可「並發」處理多請求，共用連線會語句交錯、
//   transaction 互踩、觸發跨 request I/O 限制 — Hyperdrive 路徑改用 per-instance 連線）
let cachedConnection = null;

export class Database {
  constructor(env) {
    this.env = env;
    this.dbConfig = getDbConfig(env);
    // CF（Hyperdrive）：per-instance（= per-request，實例都在請求範圍內建立）
    this.usePerInstance = !!this.dbConfig._viaHyperdrive;
    this.connection = null;
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
  }

  async query(sql, params = []) {
    try {
      const connection = await this.getConnection();
      const [rows] = await connection.query(sql, params);
      return Array.isArray(rows) ? rows : [rows];
    } catch (error) {
      // If connection error, clear cache and retry once
      if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNRESET') {
        this.resetConnection();
        const connection = await this.getConnection();
        const [rows] = await connection.query(sql, params);
        return Array.isArray(rows) ? rows : [rows];
      }
      console.error("Database query error:", error);
      throw new Error(`Database query failed: ${error.message}`);
    }
  }

  async execute(sql, params = []) {
    try {
      const connection = await this.getConnection();
      const [result] = await connection.query(sql, params);
      return {
        meta: { last_row_id: result.insertId, changes: result.affectedRows },
      };
    } catch (error) {
      // 寫入不自動 retry：斷線可能發生在寫入「已送達」之後，重試會重複執行
      // 非冪等語句（如 ai_usage 的 cost 累加）。只重置壞連線供下次請求重建。
      if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNRESET') {
        this.resetConnection();
      }
      console.error("Database execute error:", error);
      throw new Error(`Database execute failed: ${error.message}`);
    }
  }

  async first(sql, params = []) {
    try {
      const results = await this.query(sql, params);
      return results.length > 0 ? results[0] : null;
    } catch (error) {
      console.error("Database first error:", error);
      throw new Error(`Database first failed: ${error.message}`);
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
