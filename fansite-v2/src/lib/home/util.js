// 首頁小工具：時間格式化 + 極簡 inline markdown（只認連結）

/** ISO 時間 → 本地時間 `YYYY/MM/DD HH:mm`（無效值原樣回傳，不假裝有資料） */
export function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * MySQL 原始時間字串（'2026-08-08 01:20:39.832203'，無時區資訊）→ 截到分鐘。
 * ⚠️ 刻意不做時區換算：後端回傳的是 DB 原始值，硬換算會顯示出錯誤的當地時間。
 */
export function formatDbTime(value) {
  if (typeof value !== 'string' || !value) return '—'
  return value.replace('T', ' ').slice(0, 16)
}

const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g

/** 只允許 http(s) 與站內絕對路徑，擋掉 javascript: 之類 */
function safeHref(url) {
  return /^(https?:\/\/|\/)/i.test(url) ? url : null
}

/**
 * 把 `[text](url)` 拆成 token 陣列供模板渲染（**不用 {@html}**，其餘一律當純文字）。
 * @returns {Array<{ text: string, href?: string }>}
 */
export function parseInlineLinks(text) {
  const s = String(text ?? '')
  const out = []
  let last = 0
  let m
  LINK_RE.lastIndex = 0
  while ((m = LINK_RE.exec(s)) !== null) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) })
    const href = safeHref(m[2])
    out.push(href ? { text: m[1], href } : { text: m[0] })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ text: s.slice(last) })
  return out.length ? out : [{ text: s }]
}
