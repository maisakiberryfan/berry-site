import mysql from 'mysql2/promise'
import { dbConfig } from './db-config.cjs'
import fs from 'fs'

const BACKUP_SQL = 'e:/tmp/restore_setlist_ori.sql'

const conn = await mysql.createConnection({ ...dbConfig('mbdb'), multipleStatements: true })

// Read extracted setlist_ori SQL (LOCK + INSERT + UNLOCK)
const sql = fs.readFileSync(BACKUP_SQL, 'utf-8')

// Count expected rows from backup (each data line = one row, ends with ), or );)
const rowCount = (sql.match(/\),?\n/g) || []).length
console.log(`Backup SQL loaded: ~${rowCount} rows expected`)

// Step 1: Get current state
const [[{ cnt: beforeCount }]] = await conn.query('SELECT COUNT(*) as cnt FROM setlist_ori')
const [[{ cnt: beforeEndTime }]] = await conn.query('SELECT COUNT(*) as cnt FROM setlist_ori WHERE endTime IS NOT NULL')
console.log(`Before: ${beforeCount} rows, ${beforeEndTime} with endTime`)

// Step 2: Truncate and restore
console.log('Truncating setlist_ori...')
await conn.query('SET FOREIGN_KEY_CHECKS=0')
await conn.query('TRUNCATE TABLE setlist_ori')

console.log('Restoring from backup (this may take a moment)...')
// The SQL file contains LOCK + DISABLE KEYS + INSERT(s) + ENABLE KEYS + UNLOCK + commit
await conn.query(sql)
await conn.query('SET FOREIGN_KEY_CHECKS=1')

// Step 3: Verify
const [[{ cnt: afterCount }]] = await conn.query('SELECT COUNT(*) as cnt FROM setlist_ori')
const [[{ cnt: afterEndTime }]] = await conn.query('SELECT COUNT(*) as cnt FROM setlist_ori WHERE endTime IS NOT NULL')
const [[{ cnt: afterNull }]] = await conn.query('SELECT COUNT(*) as cnt FROM setlist_ori WHERE endTime IS NULL')
console.log(`After restore: ${afterCount} rows, ${afterEndTime} with endTime, ${afterNull} without`)

if (afterCount !== 14708) {
  console.error(`⚠ WARNING: Expected 14708 rows, got ${afterCount}`)
}

// Step 4: Re-apply 3 confirmed fixes
console.log('\nRe-applying 3 confirmed fixes...')

const [r1] = await conn.query("UPDATE setlist_ori SET endTime = 4810 WHERE streamID = 'fTzUZ56Hbig' AND trackNo = 9")
console.log(`  fTzUZ56Hbig #9 endTime=4810: ${r1.affectedRows} row(s)`)

const [r2] = await conn.query("UPDATE setlist_ori SET startTime = 8379 WHERE streamID = 'APsWa17nmiA' AND trackNo = 17")
console.log(`  APsWa17nmiA #17 startTime=8379: ${r2.affectedRows} row(s)`)

const [r3] = await conn.query("UPDATE setlist_ori SET startTime = 3240 WHERE streamID = 'mxelTFnDFF4' AND trackNo = 7")
console.log(`  mxelTFnDFF4 #7 startTime=3240: ${r3.affectedRows} row(s)`)

// Step 5: Spot-check
console.log('\nSpot-check:')
const [check1] = await conn.query("SELECT streamID, trackNo, startTime, endTime FROM setlist_ori WHERE streamID = 'fTzUZ56Hbig' AND trackNo = 9")
console.log(`  fTzUZ56Hbig #9:`, check1[0])

const [check2] = await conn.query("SELECT streamID, trackNo, startTime, endTime FROM setlist_ori WHERE streamID = 'APsWa17nmiA' AND trackNo = 17")
console.log(`  APsWa17nmiA #17:`, check2[0])

const [check3] = await conn.query("SELECT streamID, trackNo, startTime, endTime FROM setlist_ori WHERE streamID = 'mxelTFnDFF4' AND trackNo = 7")
console.log(`  mxelTFnDFF4 #7:`, check3[0])

// Check a few random records to ensure endTime values are restored
const [sample] = await conn.query(`
  SELECT streamID, trackNo, songID, startTime, endTime
  FROM setlist_ori
  WHERE endTime IS NOT NULL
  ORDER BY RAND()
  LIMIT 5
`)
console.log('\nRandom sample (should have real endTime values):')
for (const s of sample) {
  console.log(`  ${s.streamID} #${s.trackNo} songID=${s.songID} start=${s.startTime} end=${s.endTime} dur=${s.endTime - s.startTime}s`)
}

await conn.end()
console.log('\nDone!')
