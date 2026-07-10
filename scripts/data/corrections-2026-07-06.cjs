// 用戶實聽修正寫入（2026-07-06 第二輪）— node apply-manual-corrections.cjs [--db=mbdb]
// 每筆 UPDATE 的 WHERE 帶舊值驗證（樂觀鎖），舊值不符即跳過並回報
const { createRequire } = require('module')
const req = createRequire('E:/website/berry-site/package.json')
const mysql = req('mysql2/promise')

const dbArg = process.argv.find(a => a.startsWith('--db='))
const DB = dbArg ? dbArg.split('=')[1] : 'mbdb_test'

// { key, expect: {現值檢查}, set: {新值}, why }
const FIXES = [
  { s: 'AHomzXlgjCI', t: 5, expect: { startTime: 2518 }, set: { startTime: 2505 }, why: '心拍数 41:45（上次改錯行的本意）' },
  { s: 'AHomzXlgjCI', t: 8, expect: { endTime: null }, set: { endTime: 3843 }, why: 'シャルル end 1:04:03 實聽' },
  { s: 'AHomzXlgjCI', t: 9, expect: { startTime: 2505, endTime: 2759 }, set: { startTime: 3958, endTime: 4206 }, why: 'Lemon 1:05:58~1:10:06 實聽（撤銷上次錯改）' },
  { s: '9gBYc-Sj-3o', t: 6, expect: { endTime: null }, set: { endTime: 2925 }, why: 'うたかた花火 end 48:45 實聽' },
  { s: '9gBYc-Sj-3o', t: 7, expect: { startTime: 2400, endTime: 2568 }, set: { startTime: 3001, endTime: 3166 }, why: '大正浪漫 50:01~52:46 實聽（時間戳少10分）' },
  { s: 'mdB3NZYs1lo', t: 7, expect: { endTime: 3160 }, set: { endTime: 3170 }, why: '火葬曲 實聽 52:50' },
  { s: 'Nd50pWE0p-E', t: 7, expect: { endTime: 3358 }, set: { endTime: 3360 }, why: 'Wonderful Rush 實聽 56:00' },
  { s: 'jEX3RErwNvk', t: 9, expect: { endTime: 3962 }, set: { endTime: 3970 }, why: 'エブリデイワールド 實聽 1:06:10' },
  { s: 'lvhVDp8DL-4', t: 55, expect: { endTime: 20192 }, set: { endTime: 20328 }, why: 'キリトリセン 實聽 5:38:48（低conf大偏差）' },
  { s: 'Q4nHOeY9Up0', t: 47, expect: { endTime: 15315 }, set: { endTime: 15362 }, why: 'はじめてのチュウ 實聽 4:16:02（低conf）' },
  // #11 ワルキューレはあきらめない：st 由音訊偵測補充後加入
]
const EXTRA = process.env.VALKYRIE_ST ? [{
  s: '0PWgDlP9TRU', t: 13,
  expect: { startTime: 6215, endTime: 6309 },
  set: { startTime: Number(process.env.VALKYRIE_ST), endTime: 6124 },
  why: `ワルキューレはあきらめない end 實聽 1:42:04、st 音訊偵測 ${process.env.VALKYRIE_ST}`,
}] : []

async function main() {
  const fixes = [...FIXES, ...EXTRA]
  const conn = await mysql.createConnection({
    host: '163.44.98.136', port: 8081, user: 'root', password: '<REDACTED>', database: DB,
    ssl: { rejectUnauthorized: false },
  })
  console.log(`目標 DB: ${DB}${DB === 'mbdb_test' ? '（演練）' : '（正式）'}，修正 ${fixes.length} 筆`)
  await conn.beginTransaction()
  let ok = 0
  const skipped = []
  try {
    for (const f of fixes) {
      const setSql = Object.keys(f.set).map(k => `${k} = ?`).join(', ')
      const wheres = ['streamID = ?', 'segmentNo = 1', 'trackNo = ?']
      const params = [...Object.values(f.set), f.s, f.t]
      for (const [k, v] of Object.entries(f.expect)) {
        if (v === null) wheres.push(`${k} IS NULL`)
        else { wheres.push(`CAST(${k} AS SIGNED) = ?`); params.push(v) }
      }
      const [res] = await conn.query(`UPDATE setlist_ori SET ${setSql} WHERE ${wheres.join(' AND ')}`, params)
      if (res.affectedRows === 1) { ok++; console.log(`  OK  ${f.s}#${f.t}  ${f.why}`) }
      else { skipped.push(f); console.log(`  SKIP（舊值不符）  ${f.s}#${f.t}  ${f.why}`) }
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    console.error(`ROLLBACK: ${e.message}`)
    process.exit(1)
  }
  console.log(`完成: ok=${ok} skipped=${skipped.length}`)
  await conn.end()
}
main().catch(e => { console.error(e.message); process.exit(1) })
