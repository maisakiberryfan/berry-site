/**
 * Platform abstraction layer
 * Handles differences between Cloudflare Workers and AWS Lambda
 */

/**
 * Get database connection config
 * CF: env.HYPERDRIVE object | AWS: process.env.DB_* | wrangler dev: env.DB_*
 */
export function getDbConfig(env) {
  if (env?.HYPERDRIVE) {
    return {
      host: env.HYPERDRIVE.host,
      port: env.HYPERDRIVE.port,
      user: env.HYPERDRIVE.user,
      password: env.HYPERDRIVE.password,
      database: env.HYPERDRIVE.database
    }
  }
  // AWS Lambda (process.env) 或 wrangler dev (env bindings from .dev.vars)
  return {
    host: env?.DB_HOST || process.env.DB_HOST,
    port: parseInt(env?.DB_PORT || process.env.DB_PORT),
    user: env?.DB_USER || process.env.DB_USER,
    password: env?.DB_PASSWORD || process.env.DB_PASSWORD,
    database: env?.DB_NAME || process.env.DB_NAME
  }
}

/**
 * Get secret/env variable
 * CF: env bindings | AWS: process.env
 */
export function getSecret(env, name) {
  return env?.[name] || process.env[name]
}
