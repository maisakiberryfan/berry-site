// 圖表共用小工具：數字格式化、SVG 文字寬度估算、座標軸刻度
//
// SVG 內沒有 text overflow / ellipsis，長標籤要自己截；字寬用「全形 1em、半形 0.55em」估算，
// 對日文＋英數混排的曲名夠準（誤差幾 px，標籤欄本來就留了餘裕）。

/** 千分位（固定 en-US 分隔符，三語顯示一致，不受瀏覽器 locale 影響） */
export function formatNumber(n) {
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString('en-US') : '—'
}

// 全形字範圍（CJK、假名、諺文、全形符號）
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-﹯＀-｠￠-￦]/

/** 估算文字在指定字級下的顯示寬度（px） */
export function textWidth(text, fontSize) {
  let units = 0
  for (const ch of String(text ?? '')) units += WIDE.test(ch) ? 1 : 0.55
  return units * fontSize
}

/** 超出寬度就截斷並補省略號（回傳可直接放進 <text> 的字串） */
export function fitText(text, maxWidth, fontSize) {
  const s = String(text ?? '')
  if (maxWidth <= 0) return ''
  if (textWidth(s, fontSize) <= maxWidth) return s
  const budget = maxWidth - textWidth('…', fontSize)
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = (WIDE.test(ch) ? 1 : 0.55) * fontSize
    if (used + w > budget) break
    out += ch
    used += w
  }
  return `${out}…`
}

/** 取「好看的」刻度間距：1 / 2 / 2.5 / 5 × 10^n */
function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const exp = Math.floor(Math.log10(raw))
  const base = 10 ** exp
  const f = raw / base
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nf * base
}

/**
 * 由資料最大值算出座標軸上界與刻度陣列。
 * 回傳 { max, ticks }；max ≥ maxValue，ticks 含 0 與 max。
 * minStep 預設 1：本站圖表都是「次數」，資料很少時不該出現 0.5 這種刻度。
 */
export function niceScale(maxValue, targetTicks = 4, minStep = 1) {
  const v = Math.max(minStep, Number(maxValue) || 0)
  const step = Math.max(minStep, niceStep(v / Math.max(1, targetTicks)))
  const top = Math.ceil(v / step) * step
  const list = []
  for (let t = 0; t <= top + step / 1000; t += step) list.push(Math.round(t * 1000) / 1000)
  return { max: top, ticks: list }
}
