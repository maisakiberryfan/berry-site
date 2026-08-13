// 極簡 markdown 解析器 —— 只認 fansite/pages/history.md 既有的固定格式：
//   `## YYYY`                    年份標題
//   `* YYYY/MM/DD　text`         條列（text 可能含 0~N 個 [text](url) 內嵌連結）
//   其餘非空行                    純文字段落
//
// 刻意不支援通用 markdown 語法（粗體/巢狀清單/圖片…）——格式受控，逐行/逐 token
// 拆成結構化資料交給 Svelte 模板渲染（非 innerHTML 字串拼接），從源頭避免 XSS。

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g

/**
 * 連結 scheme 白名單 —— 只允許 http(s) 與站內絕對路徑，擋掉 javascript:/data: 等注入。
 * ⚠️ 與 src/lib/home/util.js 的 safeHref() 邏輯逐字相同，刻意未抽共用（該檔改動範圍外）。
 */
function safeHref(url) {
  return /^(https?:\/\/|\/)/i.test(url) ? url : null
}

/** 把一段文字拆成 {type:'text'} / {type:'link'} 片段陣列（供模板逐段渲染） */
function parseInline(text) {
  const segments = []
  let lastIndex = 0
  let m
  LINK_RE.lastIndex = 0
  while ((m = LINK_RE.exec(text))) {
    if (m.index > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, m.index) })
    const href = safeHref(m[2])
    // scheme 未過白名單：不產生可點擊連結，退回原始 `[text](url)` 純文字呈現
    segments.push(href ? { type: 'link', text: m[1], url: href } : { type: 'text', value: m[0] })
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) })
  if (segments.length === 0) segments.push({ type: 'text', value: '' })
  return segments
}

/**
 * 解析 history.md 全文，回傳 block 陣列：
 *   { type: 'year', year }
 *   { type: 'item', date, segments }   ← segments 為 parseInline() 結果
 *   { type: 'paragraph', text }
 */
export function parseHistoryMarkdown(raw) {
  const blocks = []
  const lines = raw.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const heading = trimmed.match(/^##\s+(.+)$/)
    if (heading) {
      blocks.push({ type: 'year', year: heading[1].trim() })
      continue
    }

    const bullet = trimmed.match(/^\*\s+(.*)$/)
    if (bullet) {
      const rest = bullet[1]
      // 日期 token：開頭連續非空白字元（含「~」日期範圍），後面接任意空白（含全形空格）分隔內文
      const dm = rest.match(/^(\S+)[ \t　]+(.*)$/)
      if (dm) {
        blocks.push({ type: 'item', date: dm[1], segments: parseInline(dm[2]) })
      } else {
        blocks.push({ type: 'item', date: '', segments: parseInline(rest) })
      }
      continue
    }

    blocks.push({ type: 'paragraph', text: trimmed })
  }

  return blocks
}
