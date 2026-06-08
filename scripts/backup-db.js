import mysql from 'mysql2/promise'
import fs from 'fs'

const conn = await mysql.createConnection({
  host: '163.44.98.136', port: 8081, user: 'root', password: '***REMOVED***', database: 'mbdb',
  ssl: { rejectUnauthorized: false }
})

const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
const outFile = `e:/tmp/backup_mbdb_${ts}.sql`

const escape = v => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

// Get all real tables (exclude views)
const [tables] = await conn.query(`
  SELECT TABLE_NAME FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = 'mbdb' AND TABLE_TYPE = 'BASE TABLE'
  ORDER BY TABLE_NAME
`)

let sql = `-- Full backup of mbdb @ ${new Date().toISOString()}\n`
sql += `-- Tables: ${tables.map(t => t.TABLE_NAME).join(', ')}\n\n`
sql += `SET FOREIGN_KEY_CHECKS=0;\n\n`

for (const { TABLE_NAME: table } of tables) {
  // Get CREATE TABLE
  const [[{ 'Create Table': createSql }]] = await conn.query(`SHOW CREATE TABLE \`${table}\``)
  sql += `-- ${table}\n`
  sql += `DROP TABLE IF EXISTS \`${table}\`;\n`
  sql += createSql + ';\n\n'

  // Get data
  const [rows] = await conn.query(`SELECT * FROM \`${table}\``)
  console.log(`${table}: ${rows.length} rows`)

  if (rows.length > 0) {
    sql += `LOCK TABLES \`${table}\` WRITE;\n`
    for (let i = 0; i < rows.length; i += 1000) {
      const batch = rows.slice(i, i + 1000)
      sql += `INSERT INTO \`${table}\` VALUES\n`
      sql += batch.map(r => `(${Object.values(r).map(escape).join(',')})`).join(',\n')
      sql += ';\n'
    }
    sql += `UNLOCK TABLES;\n\n`
  }
}

// Also dump view definitions
const [views] = await conn.query(`
  SELECT TABLE_NAME FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = 'mbdb' AND TABLE_TYPE = 'VIEW'
`)
for (const { TABLE_NAME: view } of views) {
  const [[{ 'Create View': createView }]] = await conn.query(`SHOW CREATE VIEW \`${view}\``)
  sql += `-- View: ${view}\n`
  sql += `DROP VIEW IF EXISTS \`${view}\`;\n`
  sql += createView + ';\n\n'
  console.log(`${view}: (view)`)
}

sql += `SET FOREIGN_KEY_CHECKS=1;\n`

fs.writeFileSync(outFile, sql)
console.log(`\nSaved to ${outFile} (${(sql.length / 1024 / 1024).toFixed(1)} MB)`)

await conn.end()
