// DB 連線設定：讀環境變數，缺值時 fallback 讀 repo 根目錄 .env（不再硬編碼憑證）
const fs = require('fs')
const path = require('path')

function loadDotenv() {
  for (const p of [path.join(process.cwd(), '.env'), path.join(__dirname, '..', '.env')]) {
    try {
      const txt = fs.readFileSync(p, 'utf8')
      return Object.fromEntries(txt.split(/\r?\n/)
        .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
    } catch {}
  }
  return {}
}

function dbConfig(database = 'mbdb') {
  const env = process.env.DB_PASSWORD ? process.env : loadDotenv()
  if (!env.DB_PASSWORD) throw new Error('DB_PASSWORD not found — set env vars or provide .env at repo root')
  return {
    host: env.DB_HOST, port: Number(env.DB_PORT || 3306),
    user: env.DB_USER, password: env.DB_PASSWORD, database,
    ssl: { rejectUnauthorized: false },
  }
}

module.exports = { dbConfig }
