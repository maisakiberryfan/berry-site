/**
 * endTime 補填執行器 — 讀 e:/tmp/endtime_backfill_plan.json 的 plan 陣列寫入 DB
 *
 * 用法:
 *   node scripts/execute-endtime-backfill.js                 # 演練 → mbdb_test
 *   node scripts/execute-endtime-backfill.js --db=mbdb       # 正式寫入（顯式指定）
 *
 * 守衛:
 *   - WHERE endTime IS NULL（不覆寫既有值）
 *   - AND startTime=計畫值（樂觀鎖：計畫產出後 startTime 被改過的行跳過）
 *   - transaction，全程逐筆 affectedRows 檢查
 */
import mysql from 'mysql2/promise'
import fs from 'fs'

const dbArg = process.argv.find(a => a.startsWith('--db='))
const DB = dbArg ? dbArg.split('=')[1] : 'mbdb_test'
if (!['mbdb', 'mbdb_test'].includes(DB)) {
  console.error(`未知 DB: ${DB}`)
  process.exit(1)
}

const PLAN_FILE = 'e:/tmp/endtime_backfill_plan.json'
const { plan, summary, generated } = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'))
console.log(`計畫: ${PLAN_FILE}（產出於 ${generated}）`)
console.log(`目標 DB: ${DB}${DB === 'mbdb_test' ? '（演練）' : '（正式）'}`)
console.log(`待寫入: ${plan.length} 筆\n`)

const conn = await mysql.createConnection({
  host: '163.44.98.136', port: 8081, user: 'root', password: '***REMOVED***', database: DB,
  ssl: { rejectUnauthorized: false }
})

// 寫入前基準
const [[before]] = await conn.query(
  `SELECT COUNT(*) c FROM setlist_ori WHERE endTime IS NULL AND startTime IS NOT NULL`)
console.log(`寫入前缺 endTime: ${before.c}`)

await conn.beginTransaction()
let updated = 0
const skipped = []
const t0 = Date.now()
try {
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]
    const [res] = await conn.query(
      `UPDATE setlist_ori SET endTime = ?
       WHERE streamID = ? AND segmentNo = ? AND trackNo = ?
         AND endTime IS NULL AND startTime = ?`,
      [p.endTime, p.streamID, p.segmentNo, p.trackNo, p.startTime]
    )
    if (res.affectedRows === 1) updated++
    else skipped.push(p)
    if ((i + 1) % 500 === 0) console.log(`  ${i + 1}/${plan.length}  (updated=${updated}, skipped=${skipped.length}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  }
  await conn.commit()
  console.log(`\nCOMMIT。updated=${updated}, skipped=${skipped.length}, 耗時 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
} catch (e) {
  await conn.rollback()
  console.error(`\n錯誤，已 ROLLBACK: ${e.message}`)
  await conn.end()
  process.exit(1)
}

// skipped 原因分析
if (skipped.length > 0) {
  console.log(`\n=== skipped 明細（${skipped.length} 筆）===`)
  for (const p of skipped) {
    const [rows] = await conn.query(
      `SELECT CAST(startTime AS SIGNED) st, CAST(endTime AS SIGNED) et
       FROM setlist_ori WHERE streamID=? AND segmentNo=? AND trackNo=?`,
      [p.streamID, p.segmentNo, p.trackNo])
    let reason
    if (!rows.length) reason = 'row 不存在'
    else if (rows[0].et != null) reason = `endTime 已有值(${rows[0].et})`
    else if (Number(rows[0].st) !== p.startTime) reason = `startTime 已變(${rows[0].st} ≠ 計畫${p.startTime})`
    else reason = '未知'
    console.log(`  ${p.streamID} seg${p.segmentNo}#${p.trackNo} ${p.songName}: ${reason}`)
  }
  fs.writeFileSync(`e:/tmp/backfill_skipped_${DB}.json`, JSON.stringify(skipped, null, 1))
}

// 寫入後驗證
const [[after]] = await conn.query(
  `SELECT COUNT(*) c FROM setlist_ori WHERE endTime IS NULL AND startTime IS NOT NULL`)
console.log(`\n寫入後缺 endTime: ${after.c}（前 ${before.c} − 更新 ${updated} = ${before.c - updated}）${Number(after.c) === Number(before.c) - updated ? ' ✓' : ' ✗ 不一致!'}`)

// 抽樣核對 5 筆
const samples = [0, Math.floor(plan.length * 0.25), Math.floor(plan.length * 0.5), Math.floor(plan.length * 0.75), plan.length - 1]
console.log(`\n=== 抽樣核對 ===`)
for (const idx of samples) {
  const p = plan[idx]
  const [rows] = await conn.query(
    `SELECT CAST(endTime AS SIGNED) et FROM setlist_ori WHERE streamID=? AND segmentNo=? AND trackNo=?`,
    [p.streamID, p.segmentNo, p.trackNo])
  const et = rows.length ? Number(rows[0].et) : null
  const ok = et === p.endTime
  console.log(`  ${p.streamID} seg${p.segmentNo}#${p.trackNo} ${p.songName}: DB=${et} 計畫=${p.endTime} ${ok ? '✓' : (skipped.some(s => s.streamID === p.streamID && s.segmentNo === p.segmentNo && s.trackNo === p.trackNo) ? '(skipped)' : '✗')}`)
}

await conn.end()
