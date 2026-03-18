// Database connection utility - platform-agnostic (CF Hyperdrive / AWS Lambda)
import { createConnection } from "mysql2/promise";
import { getDbConfig } from "../platform.js";

// Module-level connection cache for Lambda warm start reuse
let cachedConnection = null;

export class Database {
  constructor(env) {
    this.env = env;
    this.dbConfig = getDbConfig(env);
  }

  async getConnection() {
    // Reuse cached connection if alive
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

    cachedConnection = await createConnection({
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
    });

    return cachedConnection;
  }

  async query(sql, params = []) {
    try {
      const connection = await this.getConnection();
      const [rows] = await connection.query(sql, params);
      return Array.isArray(rows) ? rows : [rows];
    } catch (error) {
      // If connection error, clear cache and retry once
      if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNRESET') {
        cachedConnection = null;
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
      if (error.code === 'PROTOCOL_CONNECTION_LOST' || error.code === 'ECONNRESET') {
        cachedConnection = null;
        const connection = await this.getConnection();
        const [result] = await connection.query(sql, params);
        return {
          meta: { last_row_id: result.insertId, changes: result.affectedRows },
        };
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
