// 列表頁共用純函式（無 runes，可直接被 .svelte / .js 引用）
//
// 內容：全文搜尋、排序、日期/秒數格式化、CSV / JSON 匯出、YouTube URL 解析、
//       ApiError 的 fieldErrors 正規化。

/* ========================= 版面 ========================= */

/**
 * 手機版斷點（與 Tailwind `md` 同界）。DataTable 切卡片模式、頁面決定要不要露出
 * 編輯類入口都比對這一條——常數共用才不會兩邊斷點各走各的。
 */
export const MOBILE_MQ = '(max-width: 767px)'

/* ========================= 搜尋 ========================= */

// 查詢語法（各頁 placeholder 即提示，不另外放說明文字）：
//   苺咲 anisong          空白分隔＝AND 全文
//   "hello world"         引號括住含空白的詞
//   歌手:苺咲べりぃ        欄位限定（欄位別名表由各頁傳入 aliases）
//   歌手:"苺咲 べりぃ"     欄位限定＋含空白的值
// 全形冒號「：」、全形空白與彎引號「“ ”」一併吃（中日輸入法常態）。
// 欄位名比不到別名表時，整個 token（含冒號）退回當全文詞——例如時間「12:34」不會被誤拆。

const SPACE_RE = /[\s　]/
const QUOTE_RE = /["“”]/
const COLON_RE = /[:：]/

/**
 * 從 i 讀一段文字：遇（未被引號包住的）空白停；stopAtColon 時遇冒號也停。
 * 引號內的空白／冒號視為一般字元。
 */
function readChunk(s, i, stopAtColon) {
  let text = ''
  let quoted = false
  while (i < s.length) {
    const ch = s[i]
    if (QUOTE_RE.test(ch)) {
      quoted = true
      i++
      while (i < s.length && !QUOTE_RE.test(s[i])) text += s[i++]
      if (i < s.length) i++ // 收尾引號（沒有也算讀完）
      continue
    }
    if (SPACE_RE.test(ch)) break
    if (stopAtColon && COLON_RE.test(ch)) break
    text += ch
    i++
  }
  return { text, next: i, quoted }
}

/**
 * 查詢字串切成 token（AND 語意）。
 * @returns {{field: string|null, value: string, raw: string}[]}
 *   field 為 null＝全文詞；raw 為欄位別名比不到時的全文 fallback 用字（含冒號）。
 */
export function tokenize(q) {
  const s = String(q ?? '')
  const out = []
  let i = 0
  while (i < s.length) {
    if (SPACE_RE.test(s[i])) {
      i++
      continue
    }
    const head = readChunk(s, i, true)
    i = head.next

    let field = null
    let value = head.text
    let raw = head.text

    if (!head.quoted && i < s.length && COLON_RE.test(s[i])) {
      const tail = readChunk(s, i + 1, false)
      i = tail.next
      raw = `${head.text}:${tail.text}`
      // 冒號在最前面（":abc"）＝沒有欄位名，整串當全文
      if (head.text) {
        field = head.text.toLowerCase()
        value = tail.text
      } else {
        value = raw
      }
    }

    if (field) {
      // 「歌手:」打到一半＝還沒有值，先不套用條件（否則會瞬間變 0 筆）
      if (value) out.push({ field, value: value.toLowerCase(), raw: raw.toLowerCase() })
    } else if (raw) {
      out.push({ field: null, value: raw.toLowerCase(), raw: raw.toLowerCase() })
    }
  }
  return out
}

/**
 * 由列組出小寫 haystack。
 * fields 元素可為欄位名字串，或 (row) => any 的取值函式（例如格式化後的日期）。
 */
export function buildHaystack(row, fields) {
  let s = ''
  for (const f of fields) {
    const v = typeof f === 'function' ? f(row) : row[f]
    if (v == null || v === '') continue
    s += (Array.isArray(v) ? v.join(' ') : String(v)).toLowerCase()
    s += ' ' // 欄位分隔：避免「前一欄尾＋後一欄頭」被誤判為命中
  }
  return s
}

/**
 * 純字串 haystack 比對（Combobox 等單一字串來源用）：不套欄位限定，
 * 一律以 token 的 raw 當關鍵字。
 */
export function matchesTokens(haystack, tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]
    if (!haystack.includes(typeof tk === 'string' ? tk : tk.raw)) return false
  }
  return true
}

/**
 * 列比對：欄位限定 token 只比該欄位，其餘走全文（haystack 惰性建構，
 * 純欄位條件的查詢不必為每列組整串）。
 * @param {any} row
 * @param {ReturnType<typeof tokenize>} tokens
 * @param {(string|((row:any)=>any))[]} fields 全文搜尋欄位
 * @param {Record<string, (string|((row:any)=>any))[]>} [aliases] 欄位別名表（key 小寫）
 */
export function matchesQuery(row, tokens, fields, aliases) {
  let hay = null
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]
    // Object.hasOwn＋Array.isArray 把關：`constructor:x` 這類欄位名會撈到
    // Object.prototype 成員（truthy 但非陣列），直接餵 buildHaystack 會拋 not iterable
    const spec =
      tk.field && aliases && Object.hasOwn(aliases, tk.field) && Array.isArray(aliases[tk.field])
        ? aliases[tk.field]
        : null
    if (spec) {
      // `欄位:*`＝該欄不為空（備註欄稀疏，讓使用者先撈出「有寫東西的列」）
      if (tk.value === '*' || tk.value === '＊') {
        if (!buildHaystack(row, spec).trim()) return false
        continue
      }
      if (!buildHaystack(row, spec).includes(tk.value)) return false
      continue
    }
    // 欄位名不認得 → 整個 token 當全文詞
    if (hay === null) hay = buildHaystack(row, fields)
    if (!hay.includes(tk.raw)) return false
  }
  return true
}

/**
 * 語法說明用的欄位名顯示：英文介面只列英文別名，中／日介面同時列出母語與英文。
 * （別名表本身三語全收，這裡只挑要展示的兩個）
 */
export function syntaxName(lang, zh, ja, en) {
  if (lang === 'en') return en
  return `${lang === 'ja' ? ja : zh} / ${en}`
}

/** 便利組合：對 rows 做過濾（tokens 為空時原樣回傳，不複製陣列） */
export function filterRows(rows, tokens, fields, aliases) {
  if (!tokens.length) return rows
  const out = []
  for (const row of rows) {
    if (matchesQuery(row, tokens, fields, aliases)) out.push(row)
  }
  return out
}

/* ===================== 欄位篩選（DataTable 篩選列） ===================== */

// DataTable 只負責篩選列的 UI 與值（{ 欄key: 值 }），實際過濾在頁面端做，
// 才能與全域搜尋、FilterChips 疊加成同一個 AND 條件、共用同一次走訪。
//
// 用法：
//   const active = $derived(compileColumnFilters(colFilters, columns))
//   ... rows.filter((r) => matchesColumnFilters(r, active))
//
// 取值來源：col.filterValue?.(row) ?? row[col.key]，回傳字串或字串陣列。
// 比對方式：'select' 與 col.filterExact 為精確比對（陣列＝包含該值），其餘為
//           大小寫不敏感的 contains。

/**
 * 把 { 欄key: 值 } 壓成只含「有值欄位」的比對器陣列；沒有任何條件時回 null
 * （呼叫端可直接略過整輪過濾，不必為每列跑空迴圈）。
 *
 * @param {Record<string, string>} columnFilters
 * @param {{key: string, filter?: 'text'|'select'|false, filterExact?: boolean, filterValue?: (row:any)=>any}[]} columns
 * @param {string|null} [exclude] 略過某一欄（select 計數的 cascade 用：
 *   算某欄選項的計數時，不能把該欄自己的條件算進去）
 */
export function compileColumnFilters(columnFilters, columns, exclude = null) {
  if (!columnFilters) return null
  const out = []
  for (const col of columns) {
    const mode = col.filter ?? 'text'
    if (mode === false || col.key === exclude) continue
    const raw = columnFilters[col.key]
    const value = raw == null ? '' : String(raw).trim()
    if (!value) continue
    const get = col.filterValue ?? ((row) => row[col.key])
    const exact = mode === 'select' || col.filterExact === true
    out.push({ get, exact, needle: exact ? value : value.toLowerCase() })
  }
  return out.length ? out : null
}

/** @param {ReturnType<typeof compileColumnFilters>} compiled */
export function matchesColumnFilters(row, compiled) {
  if (!compiled) return true
  for (let i = 0; i < compiled.length; i++) {
    const { get, needle, exact } = compiled[i]
    const v = get(row)
    if (exact) {
      if (Array.isArray(v)) {
        if (!v.some((item) => String(item) === needle)) return false
      } else if (String(v ?? '') !== needle) return false
      continue
    }
    const s = Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v)
    if (!s.toLowerCase().includes(needle)) return false
  }
  return true
}

/**
 * distinct 值計數（select 篩選的選項用）。getter 回陣列時逐項計數（分類等多值欄）。
 * @returns {Map<string, number>}
 */
export function countDistinct(rows, getter) {
  const counts = new Map()
  for (const row of rows) {
    const v = getter(row)
    if (v == null || v === '') continue
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item == null || item === '') continue
        counts.set(String(item), (counts.get(String(item)) ?? 0) + 1)
      }
    } else {
      counts.set(String(v), (counts.get(String(v)) ?? 0) + 1)
    }
  }
  return counts
}

/* ========================= 排序 ========================= */

// Intl.Collator 實例快取：15k 列排序時 localeCompare 逐次建構會慢一個量級
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function compareValues(a, b) {
  const aEmpty = a == null || a === ''
  const bEmpty = b == null || b === ''
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1 // 空值一律殿後（不隨升降序翻面前的原始比較）
  if (bEmpty) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return collator.compare(String(a), String(b))
}

/**
 * @param {any[]} rows
 * @param {{key: string, dir: 'asc'|'desc'}|null} sort
 * @param {{key: string, sortValue?: (row:any)=>any}[]} columns
 */
export function applySort(rows, sort, columns) {
  if (!sort?.key || !sort?.dir) return rows
  const col = columns.find((c) => c.key === sort.key)
  const getter = col?.sortValue ?? ((r) => r[sort.key])
  const dir = sort.dir === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const av = getter(a)
    const bv = getter(b)
    // 空值恆殿後（不隨升降序翻面）：時長等大量 null 的欄位才不會把空列頂到最前
    const aEmpty = av == null || av === ''
    const bEmpty = bv == null || bv === ''
    if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1
    return dir * compareValues(av, bv)
  })
}

/** 欄頭點擊循環：none → asc → desc → none */
export function nextSort(sort, key) {
  if (!sort || sort.key !== key) return { key, dir: 'asc' }
  if (sort.dir === 'asc') return { key, dir: 'desc' }
  return null
}

/* ========================= 格式化 ========================= */

const pad = (n) => String(n).padStart(2, '0')

function toDate(iso) {
  if (!iso) return null
  const d = iso instanceof Date ? iso : new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * 使用者時區標記，如 '+08:00' / '-05:30'（等同 dayjs 的 Z 格式，沿用原站慣例）。
 * 時間一律以瀏覽器本地時區顯示，欄標帶上偏移量才不會被誤讀成 UTC。
 */
export function tzLabel(d = new Date()) {
  const off = -d.getTimezoneOffset() // 分鐘；東半球為正
  const sign = off < 0 ? '-' : '+'
  const abs = Math.abs(off)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 欄標／欄位標籤補上時區，如 '時間(+08:00)' */
export function labelWithTz(label) {
  return `${label}(${tzLabel()})`
}

/** ISO(UTC) → 本地 'YYYY-MM-DD' */
export function formatDate(iso) {
  const d = toDate(iso)
  if (!d) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** ISO(UTC) → 本地 'YYYY-MM-DD HH:mm' */
export function formatDateTime(iso) {
  const d = toDate(iso)
  if (!d) return ''
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** ISO(UTC) → <input type="datetime-local"> 的本地值 */
export function toDatetimeLocalValue(iso) {
  const d = toDate(iso)
  if (!d) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** <input type="datetime-local"> 的本地值 → ISO(UTC)；無效回 null */
export function fromDatetimeLocalValue(v) {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * 'h:mm:ss' / 'm:ss' / 純秒數字串 → 秒；空字串/null → null；無效 → NaN
 * （setlist 開始/結束時間編輯欄用）
 */
export function parseHmsToSeconds(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const m = s.match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/)
  if (!m) return NaN
  const h = m[1] ? Number(m[1]) : 0
  return h * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** 秒 → 'h:mm:ss' / 'm:ss' */
export function secondsToHms(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return ''
  const total = Math.max(0, Math.floor(Number(sec)))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** 起訖秒數 → 時長字串（兩者皆有才算） */
export function durationOf(startTime, endTime) {
  if (startTime == null || endTime == null) return ''
  const d = Number(endTime) - Number(startTime)
  if (!Number.isFinite(d) || d <= 0) return ''
  return secondsToHms(d)
}

/* ========================= YouTube ========================= */

export const YT_ID_RE = /^[A-Za-z0-9_-]{9,11}$/

const YT_URL_RE =
  /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|live\/|shorts\/|embed\/|v\/))([A-Za-z0-9_-]{9,11})/

/** 從貼上的網址或裸 ID 取出 videoID；取不到回 null */
export function parseYouTubeId(input) {
  const text = String(input ?? '').trim()
  if (!text) return null
  const m = text.match(YT_URL_RE)
  if (m) return m[1]
  if (YT_ID_RE.test(text)) return text
  return null
}

export function ytWatchUrl(id) {
  return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : null
}

/** 自家 S3 縮圖（CloudFront /tb/*；dev 直連線上站避免 proxy 轉發慢） */
import { assetUrl } from '../../assets.js'
export function thumbUrl(id) {
  return assetUrl(`/tb/${encodeURIComponent(id)}.jpg`)
}

/** 縮圖 fallback：YouTube CDN */
export function ytThumbUrl(id) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`
}

/* ========================= 匯出 ========================= */

function csvCell(v) {
  if (v == null) return ''
  const s = Array.isArray(v) ? v.join(' / ') : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * @param {any[]} rows
 * @param {{key: string, label: string, value?: (row:any)=>any}[]} cols
 */
export function toCSV(rows, cols) {
  const head = cols.map((c) => csvCell(c.label)).join(',')
  const body = rows.map((r) => cols.map((c) => csvCell(c.value ? c.value(r) : r[c.key])).join(','))
  // 前置 BOM：Excel 才認得 UTF-8 中日文
  return '﻿' + [head, ...body].join('\r\n')
}

export function toJSONExport(rows, cols) {
  return JSON.stringify(
    rows.map((r) => {
      const o = {}
      for (const c of cols) o[c.key] = c.value ? c.value(r) : r[c.key]
      return o
    }),
    null,
    2,
  )
}

export function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 當前（已篩選）結果下載 */
export function exportRows(rows, cols, basename, format) {
  const stamp = formatDate(new Date())
  if (format === 'json') {
    downloadFile(`${basename}-${stamp}.json`, toJSONExport(rows, cols), 'application/json;charset=utf-8')
  } else {
    downloadFile(`${basename}-${stamp}.csv`, toCSV(rows, cols), 'text/csv;charset=utf-8')
  }
}

/* ========================= 錯誤 ========================= */

/**
 * ApiError.fieldErrors 正規化成 { field: message }。
 * 後端可能給物件 map 或 [{field, message}] 陣列，兩種都吃。
 */
export function fieldErrorMap(err) {
  const fe = err?.fieldErrors
  if (!fe) return {}
  if (Array.isArray(fe)) {
    const out = {}
    for (const item of fe) {
      if (!item) continue
      const key = item.field ?? item.path ?? item.name
      if (key) out[key] = String(item.message ?? item.msg ?? '')
    }
    return out
  }
  if (typeof fe === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(fe)) {
      out[k] = Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
    }
    return out
  }
  return {}
}

/** 空字串 → null（送出前用；後端多數欄位可為 null） */
export function nullIfBlank(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
