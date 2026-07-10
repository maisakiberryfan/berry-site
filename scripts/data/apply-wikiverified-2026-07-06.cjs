// wiki 全歷史比對通過的場次補標 wikiVerified=1（只補 NULL，不動自動驗證器的既有判定）
// node apply-wikiverified.cjs [--db=mbdb]
const { createRequire } = require('module')
const req = createRequire('E:/website/berry-site/package.json')
const mysql = req('mysql2/promise')
const { dbConfig } = require('../db-config.cjs')
const path = require('path')

const dbArg = process.argv.find(a => a.startsWith('--db='))
const DB = dbArg ? dbArg.split('=')[1] : 'mbdb_test'

const wiki = require(path.join(__dirname, 'wiki-songs-2026-07-04.json'))
const vids = [...new Set(wiki.filter(r => r.videoID).map(r => r.videoID))]

async function main() {
  const c = await mysql.createConnection(dbConfig(DB))
  console.log(`目標 DB: ${DB}${DB === 'mbdb_test' ? '（演練）' : '（正式）'}，wiki 場次 ${vids.length}`)
  const [pre] = await c.query('SELECT COUNT(*) c FROM streamlist WHERE streamID IN (?) AND wikiVerified IS NULL', [vids])
  const [res] = await c.query('UPDATE streamlist SET wikiVerified = 1 WHERE streamID IN (?) AND wikiVerified IS NULL', [vids])
  const [post] = await c.query('SELECT wikiVerified, COUNT(*) c FROM streamlist GROUP BY wikiVerified')
  console.log(`待補 ${pre[0].c} → 更新 ${res.affectedRows} 筆`)
  console.log('更新後分佈: ' + post.map(r => `${r.wikiVerified ?? 'NULL'}=${r.c}`).join(', '))
  await c.end()
}
main().catch(e => { console.error(e.message); process.exit(1) })
