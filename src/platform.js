/**
 * Platform abstraction layer
 * Handles differences between Cloudflare Workers and AWS Lambda
 */

/**
 * `DB_SSL=false`＝連線不走 TLS。只給「資料庫和網站在同一台機器、資料庫沒開 TLS」的部署用
 * （entry-node.js 的單機路線）；資料庫在別台機器時不要關。未設＝維持原本的行為。
 */
function tlsDisabled(env) {
  return String(env?.DB_SSL ?? process.env.DB_SSL ?? '').toLowerCase() === 'false'
}

/**
 * Get database connection config
 * CF: env.HYPERDRIVE object | AWS: process.env.DB_* | wrangler dev: env.DB_*
 */
export function getDbConfig(env) {
  // wrangler dev: .dev.vars 的 DB_* 優先於 Hyperdrive（避免假 localConnectionString）
  if (env?.DB_HOST) {
    return {
      host: env.DB_HOST,
      port: parseInt(env.DB_PORT),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      _noTls: tlsDisabled(env)
    }
  }
  if (env?.HYPERDRIVE) {
    return {
      host: env.HYPERDRIVE.host,
      port: env.HYPERDRIVE.port,
      user: env.HYPERDRIVE.user,
      password: env.HYPERDRIVE.password,
      database: env.HYPERDRIVE.database,
      _viaHyperdrive: true
    }
  }
  // AWS Lambda (process.env) 或 wrangler dev (env bindings from .dev.vars)
  return {
    host: env?.DB_HOST || process.env.DB_HOST,
    port: parseInt(env?.DB_PORT || process.env.DB_PORT),
    user: env?.DB_USER || process.env.DB_USER,
    password: env?.DB_PASSWORD || process.env.DB_PASSWORD,
    database: env?.DB_NAME || process.env.DB_NAME,
    _noTls: tlsDisabled(env)
  }
}

/**
 * Get secret/env variable
 * CF: env bindings | AWS: process.env
 */
export function getSecret(env, name) {
  return env?.[name] || process.env[name]
}
