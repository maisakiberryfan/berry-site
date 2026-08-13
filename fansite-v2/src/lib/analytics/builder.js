// 選取式查詢建構器：使用者用「選的」組出查詢，不必會 SQL。
//
// 這支只負責「狀態 → SQL」，不碰 UI 也不碰引擎：
//   buildQuery(state) → { sql, params, preview, skipped }
//     sql     ：帶 ? 佔位的語句，交給 sql.js 以 bind params 執行
//     params  ：對應的值（一律綁定，不做字串拼接 ⇒ 引號／萬用字元都不會出事）
//     preview ：把值內嵌回去的可讀版本，只給畫面顯示與「複製到進階模式」用
//     skipped ：值沒填完、因此沒進 SQL 的篩選條件索引（UI 標示用）
//
// 安全性：欄位名一律來自 DATASET_COLUMNS 白名單（比對不到就整條丟掉），
// 運算子來自固定表，值全部 bind ⇒ 使用者輸入永遠不會變成語法。
//
// 時間語意：berry_data.time 是瀏覽器時區的 'YYYY-MM-DD HH:MM' 固定寬度字串
// （見 dataset.js），字典序＝時序，所以日期條件直接比字串即可。

import { DATASET_COLUMNS } from './dataset.js'
import { TABLE_NAME } from './queries.js'

/** 欄位清單（kind 決定可用運算子與輸入元件） */
export const FIELDS = DATASET_COLUMNS.map((c) => ({
  key: c.key,
  kind: c.key === 'time' ? 'date' : c.sqlType === 'INTEGER' ? 'number' : 'text',
}))

const FIELD_MAP = new Map(FIELDS.map((f) => [f.key, f]))

export function fieldKind(key) {
  return FIELD_MAP.get(key)?.kind ?? null
}

/** 每個運算子適用的欄位型別與需要的值個數 */
export const OPERATORS = [
  { id: 'eq', kinds: ['text', 'number', 'date'], arity: 1 },
  { id: 'contains', kinds: ['text'], arity: 1 },
  { id: 'startsWith', kinds: ['text'], arity: 1 },
  { id: 'gt', kinds: ['number', 'date'], arity: 1 },
  { id: 'lt', kinds: ['number', 'date'], arity: 1 },
  { id: 'between', kinds: ['number', 'date'], arity: 2 },
  { id: 'notEmpty', kinds: ['text', 'number', 'date'], arity: 0 },
]

const OP_MAP = new Map(OPERATORS.map((o) => [o.id, o]))

export function operatorsFor(kind) {
  return OPERATORS.filter((o) => o.kinds.includes(kind))
}

export function operatorArity(id) {
  return OP_MAP.get(id)?.arity ?? 1
}

/** 欄位換型別後沿用原運算子可能不合法，挑一個仍適用的 */
export function coerceOperator(op, kind) {
  const cur = OP_MAP.get(op)
  if (cur && cur.kinds.includes(kind)) return op
  return operatorsFor(kind)[0]?.id ?? 'eq'
}

/**
 * 分組聚合。
 *   needsField ：要挑一個「聚合欄位」（COUNT(*) 不用）
 *   numericOnly：只對數值欄位開放（平均／總和／最大／最小）
 *   alias      ：結果欄名，同時是排序時引用的名字
 */
export const AGGREGATES = [
  { id: 'count', alias: 'rowCount', needsField: false, numericOnly: false },
  { id: 'countDistinct', alias: 'uniqueCount', needsField: true, numericOnly: false },
  { id: 'avg', alias: 'avgValue', needsField: true, numericOnly: true },
  { id: 'sum', alias: 'sumValue', needsField: true, numericOnly: true },
  { id: 'max', alias: 'maxValue', needsField: true, numericOnly: true },
  { id: 'min', alias: 'minValue', needsField: true, numericOnly: true },
]

const AGG_MAP = new Map(AGGREGATES.map((a) => [a.id, a]))

/** 數值欄位（平均／總和／最大／最小只對這些開放） */
export const NUMERIC_FIELDS = FIELDS.filter((f) => f.kind === 'number').map((f) => f.key)

/** 聚合欄位選了非數值欄時，只剩計數類可用 */
export function aggregatesFor(fieldKey) {
  const numeric = NUMERIC_FIELDS.includes(fieldKey)
  return AGGREGATES.filter((a) => !a.numericOnly || numeric)
}

export function coerceAggregate(agg, fieldKey) {
  const cur = AGG_MAP.get(agg)
  if (cur && (!cur.numericOnly || NUMERIC_FIELDS.includes(fieldKey))) return agg
  return 'count'
}

/* ========================= 常數與小工具 ========================= */

export const DEFAULT_COLUMNS = ['time', 'songName', 'artist']
export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 20000
export const COUNT_ALIAS = 'rowCount'

const pad = (n) => String(n).padStart(2, '0')

function localDay(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDay(d)
}

export function clampLimit(v) {
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, n))
}

/** 只給 preview 用的字面值（值本身走 bind，這裡是顯示／複製到編輯器） */
function literal(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  return `'${String(v).replace(/'/g, "''")}'`
}

/** LIKE 的萬用字元跳脫（配合 ESCAPE '\'） */
function likeEscape(v) {
  return String(v).replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function normalizeValue(kind, raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (kind === 'number') {
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  if (kind === 'date') return DATE_RE.test(s) ? s : null
  return s
}

/* ========================= 條件 → SQL ========================= */

/**
 * 單一條件 → { sql, params }（sql 帶 ?）；值不完整回 null（呼叫端記進 skipped）
 */
function conditionOf(filter) {
  const field = FIELD_MAP.get(filter?.field)
  if (!field) return null
  const op = OP_MAP.get(filter?.op)
  if (!op || !op.kinds.includes(field.kind)) return null

  const col = field.key
  if (op.arity === 0) {
    // 不為空：TEXT 另外排掉空字串（資料裡兩者都有）
    return {
      sql: field.kind === 'text' ? `(${col} IS NOT NULL AND ${col} <> '')` : `${col} IS NOT NULL`,
      params: [],
    }
  }

  const v1 = normalizeValue(field.kind, filter.value)
  if (v1 === null) return null
  const v2 = op.arity === 2 ? normalizeValue(field.kind, filter.value2) : null
  if (op.arity === 2 && v2 === null) return null

  if (field.kind === 'date') {
    switch (op.id) {
      case 'eq':
        return { sql: `substr(${col}, 1, 10) = ?`, params: [v1] }
      case 'gt':
        return { sql: `${col} >= ?`, params: [`${v1} 00:00`] }
      case 'lt':
        return { sql: `${col} <= ?`, params: [`${v1} 23:59`] }
      case 'between':
        return {
          sql: `(${col} >= ? AND ${col} <= ?)`,
          params: [`${v1} 00:00`, `${v2} 23:59`],
        }
    }
    return null
  }

  switch (op.id) {
    case 'eq':
      return { sql: `${col} = ?`, params: [v1] }
    case 'contains':
      return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${likeEscape(v1)}%`] }
    case 'startsWith':
      return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`${likeEscape(v1)}%`] }
    case 'gt':
      return { sql: `${col} > ?`, params: [v1] }
    case 'lt':
      return { sql: `${col} < ?`, params: [v1] }
    case 'between':
      return { sql: `(${col} BETWEEN ? AND ?)`, params: [v1, v2] }
  }
  return null
}

/** 把帶 ? 的語句還原成內嵌值的可讀版本（顯示用） */
function inline(sql, params) {
  let i = 0
  return sql.replace(/\?/g, () => literal(params[i++]))
}

/* ========================= 狀態 → 查詢 ========================= */

export function emptyFilter(field = 'songName') {
  const kind = fieldKind(field) ?? 'text'
  return { field, op: operatorsFor(kind)[0]?.id ?? 'eq', value: '', value2: '' }
}

export function defaultState() {
  return {
    columns: [...DEFAULT_COLUMNS],
    filters: [],
    group: { enabled: false, field: 'songName', agg: 'count', aggField: 'streamID' },
    sort: { field: 'time', dir: 'desc' },
    limit: DEFAULT_LIMIT,
  }
}

/**
 * 聚合的 SELECT 片段與結果欄名。
 * 設定不合法（如對文字欄取平均）時整組退回 COUNT(*)，別名同步退回，
 * 這樣 ORDER BY 引用的名字永遠對得上 SELECT。
 */
function resolveAgg(group) {
  const spec = AGG_MAP.get(group?.agg) ?? AGG_MAP.get('count')
  const field = group?.aggField
  const usable =
    !spec.needsField ||
    (FIELD_MAP.has(field) && (!spec.numericOnly || NUMERIC_FIELDS.includes(field)))
  if (!usable) return { expr: `COUNT(*) AS ${COUNT_ALIAS}`, alias: COUNT_ALIAS }

  const exprs = {
    count: `COUNT(*)`,
    countDistinct: `COUNT(DISTINCT ${field})`,
    avg: `ROUND(AVG(${field}), 1)`,
    sum: `SUM(${field})`,
    max: `MAX(${field})`,
    min: `MIN(${field})`,
  }
  return { expr: `${exprs[spec.id]} AS ${spec.alias}`, alias: spec.alias }
}

/** 分組模式下聚合欄的結果欄名（也是排序時引用的名字） */
export function aggAlias(group) {
  return resolveAgg(group).alias
}

/**
 * 建構器狀態 → 查詢。
 * @returns {{ sql: string, params: Array, preview: string, skipped: number[] }}
 */
export function buildQuery(state) {
  const group = state?.group ?? {}
  const grouping = !!group.enabled && FIELD_MAP.has(group.field)

  /* SELECT */
  let select
  let groupAlias = COUNT_ALIAS
  if (grouping) {
    const agg = resolveAgg(group)
    groupAlias = agg.alias
    select = `${group.field}, ${agg.expr}`
  } else {
    const cols = (state?.columns ?? []).filter((c) => FIELD_MAP.has(c))
    select = cols.length ? cols.join(', ') : '*'
  }

  /* WHERE */
  const clauses = []
  const params = []
  const skipped = []
  const filters = state?.filters ?? []
  filters.forEach((f, i) => {
    const cond = conditionOf(f)
    if (!cond) {
      skipped.push(i)
      return
    }
    clauses.push(cond.sql)
    params.push(...cond.params)
  })

  /* ORDER BY */
  let orderBy = ''
  const dir = state?.sort?.dir === 'asc' ? 'ASC' : 'DESC'
  if (grouping) {
    const sortField = state?.sort?.field === group.field ? group.field : groupAlias
    orderBy = `${sortField} ${dir}`
  } else if (FIELD_MAP.has(state?.sort?.field)) {
    orderBy = `${state.sort.field} ${dir}`
  }

  const limit = clampLimit(state?.limit)

  let sql = `SELECT ${select}\nFROM ${TABLE_NAME}`
  if (clauses.length) sql += `\nWHERE ${clauses.join('\n  AND ')}`
  if (grouping) sql += `\nGROUP BY ${group.field}`
  if (orderBy) sql += `\nORDER BY ${orderBy}`
  sql += `\nLIMIT ${limit}`

  return { sql, params, preview: inline(sql, params), skipped }
}

/* ========================= 快速範本 ========================= */

// 點一下就填入建構器狀態（取代舊「簡易模式」的兩個模板，並多一個「最近演唱」）
const noGroup = { enabled: false, field: 'songName', agg: 'count', aggField: 'streamID' }

export const QUICK_TEMPLATES = [
  {
    id: 'song-frequency',
    label: { zh: '歌曲演唱次數', en: 'Song play counts', ja: '楽曲の歌唱回数' },
    state: () => ({
      columns: [...DEFAULT_COLUMNS],
      filters: [],
      group: { enabled: true, field: 'songName', agg: 'count', aggField: 'streamID' },
      sort: { field: COUNT_ALIAS, dir: 'desc' },
      limit: 100,
    }),
  },
  {
    id: 'top-songs',
    label: { zh: '最近 30 天熱門', en: 'Top songs, last 30 days', ja: '直近 30 日の人気曲' },
    state: () => ({
      columns: [...DEFAULT_COLUMNS],
      filters: [{ field: 'time', op: 'gt', value: daysAgo(30), value2: '' }],
      group: { enabled: true, field: 'songName', agg: 'count', aggField: 'streamID' },
      sort: { field: COUNT_ALIAS, dir: 'desc' },
      limit: 20,
    }),
  },
  {
    id: 'monthly',
    label: { zh: '月度演唱統計', en: 'Monthly totals', ja: '月別集計' },
    state: () => ({
      columns: [...DEFAULT_COLUMNS],
      filters: [{ field: 'month', op: 'notEmpty', value: '', value2: '' }],
      group: { enabled: true, field: 'month', agg: 'count', aggField: 'streamID' },
      sort: { field: 'month', dir: 'desc' },
      limit: 24,
    }),
  },
  {
    id: 'avg-duration',
    label: { zh: '歌手平均曲長', en: 'Avg length by artist', ja: 'アーティスト別平均曲長' },
    state: () => ({
      columns: [...DEFAULT_COLUMNS],
      filters: [{ field: 'durationSec', op: 'notEmpty', value: '', value2: '' }],
      group: { enabled: true, field: 'artist', agg: 'avg', aggField: 'durationSec' },
      sort: { field: 'avgValue', dir: 'desc' },
      limit: 50,
    }),
  },
  {
    id: 'recent',
    label: { zh: '最近演唱記錄', en: 'Recent performances', ja: '最近の歌唱履歴' },
    state: () => ({
      columns: ['time', 'songName', 'artist', 'streamTitle'],
      filters: [{ field: 'time', op: 'notEmpty', value: '', value2: '' }],
      group: { ...noGroup },
      sort: { field: 'time', dir: 'desc' },
      limit: 100,
    }),
  },
  {
    id: 'karaoke',
    label: { zh: '歌枠場次曲目', en: 'Karaoke stream tracks', ja: '歌枠のセトリ' },
    state: () => ({
      columns: ['time', 'streamTitle', 'songName', 'artist'],
      filters: [{ field: 'categories', op: 'contains', value: '歌枠', value2: '' }],
      group: { ...noGroup },
      sort: { field: 'time', dir: 'desc' },
      limit: 100,
    }),
  },
]
