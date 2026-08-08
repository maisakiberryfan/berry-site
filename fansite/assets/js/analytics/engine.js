// 查詢引擎：sql.js（SQLite 編譯成 WebAssembly），完全在瀏覽器內執行。
// 建構器（builder.js）與進階 SQL 模式共用同一個 db。
//
// ── 為什麼從 DuckDB-WASM 換掉 ────────────────────────────────────────────
// 舊版首次進頁就要下載 ~20MB 引擎（jsDelivr CDN）＋ 5MB parquet 快照，實測要等好幾秒。
// sql.js 的 wasm 只有 ~0.64MB 且 self-host，資料則直接取自瀏覽器裡已有的表格快取
// （dataset.js）——不再有 cdn.jsdelivr.net 與 sqldata.m-b.win 這兩條外部管線
// （CSP 兩側同步移除），資料也從「每日快照」變成「與表格頁同一份、背景校正過的最新值」。
//
// ── 載入策略 ────────────────────────────────────────────────────────────
// 1. 本模組被 analytics.js 靜態 import，analytics.js 又由 tool.js 在進入分析頁時
//    才 dynamic import ⇒ 主 bundle 增量為 0。
// 2. sql.js 本體在 boot() 內才以 <script src> 載入，因此開頁瀏覽統計面板時
//    不會連帶下載引擎——直到使用者第一次按下「執行查詢」為止。
// 3. .js 與 .wasm 都放 /assets/vendor/（同 xlsx.full.min.js 慣例），不打 CDN；
//    需要的 CSP 只有 'wasm-unsafe-eval'（既有政策已含），沒有新的外部來源。
//    ⚠️ 必須用原生 <script src> 元素載入：jQuery 對動態插入的 script[src] 走
//    _evalUrl（同步 XHR 後 eval），CSP script-src 'self' 會視同 inline 擋下。
//
// ── 時間欄位 ────────────────────────────────────────────────────────────
// SQLite 沒有原生 timestamp：time 存成本地牆鐘字串 'YYYY-MM-DD HH:MM'，
// 固定寬度所以字典序＝時序，日期比較直接寫字串即可（見 dataset.js）。

import { TABLE_NAME } from './queries.js'
import { DATASET_COLUMNS } from './dataset.js'

const SQLJS_SCRIPT = '/assets/vendor/sql-wasm-browser.js'
const SQLJS_WASM = '/assets/vendor/sql-wasm-browser.wasm'

let db = null
let loadedRows = null // 已建表的資料來源 identity（變了就重建）
let bootPromise = null
let scriptPromise = null

export function engineReady() {
  return db !== null
}

/** 以原生 <script src> 載入 sql.js UMD（設定 window.initSqlJs） */
function loadSqlJsScript() {
  if (window.initSqlJs) return Promise.resolve(window.initSqlJs)
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script')
      el.src = SQLJS_SCRIPT
      el.onload = () => {
        if (window.initSqlJs) resolve(window.initSqlJs)
        else reject(new Error('sql.js loaded but initSqlJs is missing'))
      }
      el.onerror = () => reject(new Error('Failed to load sql.js'))
      document.head.appendChild(el)
    }).catch(err => {
      scriptPromise = null // 允許重試
      throw err
    })
  }
  return scriptPromise
}

async function boot(onStage) {
  onStage?.('engine')
  const initSqlJs = await loadSqlJsScript()
  const SQL = await initSqlJs({ locateFile: () => SQLJS_WASM })
  db = new SQL.Database()
}

/**
 * 初始化（冪等）＋ 確保資料表是最新的那份 rows。
 * onStage('engine'|'data') 回報進度，供 UI 顯示目前在等什麼。
 * 失敗時清掉 promise，讓使用者可以重試。
 */
export async function ensureEngine(rows, onStage) {
  if (!db) {
    if (!bootPromise) {
      bootPromise = boot(onStage).catch(err => {
        bootPromise = null
        throw err
      })
    }
    await bootPromise
  }
  if (rows !== loadedRows) {
    onStage?.('data')
    buildTable(rows)
  }
  return db
}

/** 由記憶體中的寬表列（重）建 berry_data；全部包在單一 transaction 內 */
function buildTable(rows) {
  const cols = DATASET_COLUMNS.map(c => c.key)
  const ddl = DATASET_COLUMNS.map(c => `${c.key} ${c.sqlType}`).join(', ')

  db.exec(`DROP TABLE IF EXISTS ${TABLE_NAME}`)
  db.exec(`CREATE TABLE ${TABLE_NAME} (${ddl})`)

  const stmt = db.prepare(
    `INSERT INTO ${TABLE_NAME} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  )
  const buf = new Array(cols.length)
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      for (let i = 0; i < cols.length; i++) {
        const v = r[cols[i]]
        buf[i] = v === undefined ? null : v
      }
      stmt.run(buf)
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 已回滾 */
    }
    throw err
  } finally {
    stmt.free()
  }

  // 常用述詞的索引（建一次 ~10ms，換掉大部分全表掃描）
  db.exec(`CREATE INDEX idx_${TABLE_NAME}_time ON ${TABLE_NAME}(time)`)
  db.exec(`CREATE INDEX idx_${TABLE_NAME}_song ON ${TABLE_NAME}(songID)`)

  loadedRows = rows
}

/* ========================= 執行與結果轉換 ========================= */

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/

/**
 * 跑完整段 SQL（可含多個以分號分隔的語句），取最後一個有輸出的語句當結果。
 * iterateStatements 不會自動執行語句，所以每一句都要 step 完。
 */
function execute(sql) {
  const it = db.iterateStatements(sql)
  let names = []
  let values = []
  let stmt = null
  try {
    for (;;) {
      const next = it.next()
      if (next.done) break
      stmt = next.value
      const cols = stmt.getColumnNames() // 零列時仍拿得到欄名
      const batch = []
      while (stmt.step()) batch.push(stmt.get())
      if (cols.length) {
        names = cols
        values = batch
      }
    }
  } finally {
    // 正常走完由 iterator 自行釋放；中途拋錯時補一刀（free 可重複呼叫）
    try {
      stmt?.free()
    } catch {
      /* ignore */
    }
  }
  return { names, values }
}

/**
 * 跑「單一語句 + 綁定參數」的版本（選取式建構器走這條）。
 * 值一律用 ? 綁定，使用者輸入的引號／萬用字元都不可能變成語法。
 */
function executeBound(sql, params) {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(params)
    const names = stmt.getColumnNames()
    const values = []
    while (stmt.step()) values.push(stmt.get())
    return { names, values }
  } finally {
    stmt.free()
  }
}

/** 由實際值推欄位型別（sql.js 不提供 schema；結果表格只需要對齊與格式提示） */
function inferColumns(names, values) {
  return names.map((name, i) => {
    let sawNumber = false
    let sawOther = false
    let sawDate = false
    let sawString = false
    for (const row of values) {
      const v = row[i]
      if (v == null) continue
      if (typeof v === 'number') sawNumber = true
      else if (typeof v === 'string') {
        sawString = true
        if (DATE_LIKE.test(v)) sawDate = true
        else sawOther = true
      } else sawOther = true
    }
    const numeric = sawNumber && !sawString && !sawOther
    const time = sawDate && !sawOther && !sawNumber
    return {
      key: name,
      type: numeric ? 'INTEGER' : time ? 'DATETIME' : sawString ? 'TEXT' : 'NULL',
      numeric,
      time
    }
  })
}

function normalize(v) {
  if (v == null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Uint8Array) return `[BLOB ${v.length} bytes]`
  if (typeof v === 'bigint') {
    return v <= Number.MAX_SAFE_INTEGER && v >= Number.MIN_SAFE_INTEGER ? Number(v) : v.toString()
  }
  return String(v)
}

/**
 * 執行 SQL。回傳 { columns, rows, ms }。
 * columns: [{ key, type, numeric, time }]，rows 為純物件（可直接餵 Tabulator / XLSX）。
 *
 * params 非空時走單語句 + bind（建構器）；否則跑整段（進階模式可含多句）。
 *
 * 對進階 SQL 不設語法黑名單（資料是客端 in-memory 副本，破壞不了任何人）——
 * 代價是使用者可能 DROP 掉工作表，偵測到就重建再跑一次。
 */
export async function runQuery(sql, rows, onStage, params = null) {
  await ensureEngine(rows, onStage)
  onStage?.('query')

  const run = () => (params?.length ? executeBound(sql, params) : execute(sql))

  const t0 = performance.now()
  let out
  try {
    out = run()
  } catch (err) {
    const msg = String(err?.message ?? err)
    if (/no such table/i.test(msg) && new RegExp(TABLE_NAME, 'i').test(msg)) {
      buildTable(rows)
      out = run()
    } else {
      throw err
    }
  }
  const ms = Math.round(performance.now() - t0)

  const columns = inferColumns(out.names, out.values)
  const result = new Array(out.values.length)
  for (let i = 0; i < out.values.length; i++) {
    const src = out.values[i]
    const o = {}
    for (let c = 0; c < columns.length; c++) o[columns[c].key] = normalize(src[c])
    result[i] = o
  }

  return { columns, rows: result, ms }
}
