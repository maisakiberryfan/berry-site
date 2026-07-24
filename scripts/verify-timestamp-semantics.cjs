// 驗證 updatedAt 的 ON UPDATE CURRENT_TIMESTAMP 語意（meta ETag 方案前置檢查）
// 用法：
//   1. 開 tunnel：ssh -N -L 13306:127.0.0.1:3306 rsshub.kat-ani.win
//   2. node scripts/verify-timestamp-semantics.cjs
// 唯讀正式 mbdb（只查 information_schema）；行為實測寫入僅在 mbdb_test。
const mysql = require('mysql2/promise')
const { dbConfig } = require('./db-config.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
function check(label, pass, detail) {
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? `（${detail}）` : ''}`)
  if (!pass) failed = true
}

async function main() {
  const cfg = { ...dbConfig('mbdb'), host: '127.0.0.1', port: Number(process.env.TUNNEL_PORT || 13306) }
  const conn = await mysql.createConnection(cfg)

  const [[ver]] = await conn.query('SELECT VERSION() AS v')
  console.log(`\n=== 伺服器版本：${ver.v} ===\n`)

  // --- 1) 正式三表 updatedAt 實際定義（唯讀 metadata） ---
  console.log('--- 正式表 schema 檢查（mbdb） ---')
  for (const t of ['streamlist', 'setlist_ori', 'songlist']) {
    const [rows] = await conn.query(
      `SELECT COLUMN_TYPE, EXTRA FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = 'mbdb' AND TABLE_NAME = ? AND COLUMN_NAME = 'updatedAt'`,
      [t],
    )
    if (!rows.length) {
      check(`${t}.updatedAt 存在`, false, '欄位不存在')
      continue
    }
    const { COLUMN_TYPE, EXTRA } = rows[0]
    check(
      `${t}.updatedAt 掛 ON UPDATE`,
      /on update current_timestamp/i.test(EXTRA),
      `${COLUMN_TYPE}, EXTRA=${EXTRA || '(空)'}`,
    )
  }

  // --- 2) 行為實測（mbdb_test.songlist，與正式表同構；berry_app 無 CREATE/DROP 權限，
  //     故插入一筆專用測試 row 實測，結束時刪除） ---
  console.log('\n--- 行為實測（mbdb_test.songlist 測試 row） ---')
  const NAME = '__ts_semantics_test__'
  await conn.query('DELETE FROM mbdb_test.songlist WHERE songName = ?', [NAME])
  const [ins] = await conn.query('INSERT INTO mbdb_test.songlist (songName) VALUES (?)', [NAME])
  const id = ins.insertId
  const ts = async () => {
    const [[r]] = await conn.query(
      'SELECT CAST(updatedAt AS CHAR) AS t FROM mbdb_test.songlist WHERE songID = ?', [id],
    )
    return r.t
  }

  try {
    const t0 = await ts()

    await sleep(50)
    await conn.query(`UPDATE mbdb_test.songlist SET songNote = 'x' WHERE songID = ?`, [id])
    const t1 = await ts()
    check('UPDATE 改值 → updatedAt 刷新', t1 > t0, `${t0} → ${t1}`)

    await sleep(50)
    await conn.query(`UPDATE mbdb_test.songlist SET songNote = 'x' WHERE songID = ?`, [id])
    const t2 = await ts()
    check('UPDATE 設相同值 → updatedAt 不動', t2 === t1, `${t1} → ${t2}`)

    await sleep(50)
    await conn.query(
      `UPDATE mbdb_test.songlist SET songNote = 'y', updatedAt = updatedAt WHERE songID = ?`, [id],
    )
    const t3 = await ts()
    check('顯式 SET updatedAt=舊值 → 抑制自動刷新（審計腳本要防的寫法）', t3 === t2, `${t2} → ${t3}`)

    // 模擬線上 UPSERT 路徑（setlist.js 的 ON DUPLICATE KEY UPDATE + IF 條件式）
    await sleep(50)
    await conn.query(`INSERT INTO mbdb_test.songlist (songID, songName, songNote) VALUES (?, ?, 'z')
      ON DUPLICATE KEY UPDATE songNote = IF(songNote IS NULL, VALUES(songNote), songNote)`, [id, NAME])
    const t4 = await ts()
    check('UPSERT 條件式維持原值 → updatedAt 不動', t4 === t3, `${t3} → ${t4}`)

    await sleep(50)
    await conn.query(`INSERT INTO mbdb_test.songlist (songID, songName, songNote) VALUES (?, ?, 'z')
      ON DUPLICATE KEY UPDATE songNote = VALUES(songNote)`, [id, NAME])
    const t5 = await ts()
    check('UPSERT 真的改值 → updatedAt 刷新', t5 > t4, `${t4} → ${t5}`)
  } finally {
    await conn.query('DELETE FROM mbdb_test.songlist WHERE songID = ?', [id])
  }
  await conn.end()
  console.log(`\n${failed ? '❌ 有項目未通過——meta ETag 方案不可直接上，見上方明細' : '✅ 全部通過——meta ETag 方案的 DB 前提成立'}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('執行失敗：', e.message)
  console.error('（請確認 tunnel 已開：ssh -N -L 13306:127.0.0.1:3306 rsshub.kat-ani.win）')
  process.exit(1)
})
