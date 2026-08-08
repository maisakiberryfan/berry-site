// 統計面板的圖表：自繪 SVG，不引入任何圖表庫（Chart.js/ECharts 都是數百 KB，
// 這裡要畫的只有三種圖，自己畫反而更小更好控色）。
//
// 響應式做法：量測容器寬度後讓 viewBox 寬度 = 容器 px 寬（1 unit = 1px），
// 這樣字級永遠是真實 px，不會像固定 viewBox 那樣在手機上被縮成看不清。
// 寬度變化由 mountChart 的 ResizeObserver 重繪。
//
// 色彩一律走 CSS 變數（草莓紅／草莓粉 + Bootstrap 的文字／邊框階層），
// 亮暗兩主題共用同一份程式碼，不烘死任何色值：
//   var(--berry-primary) / var(--berry-pink)   主題色（theme-berry.css :root）
//   var(--bs-secondary-color)                  次級文字（標籤）
//   var(--bs-tertiary-color)                   三級文字（刻度、數值）
//   var(--bs-border-color)                     格線／軌道
//   var(--bs-tertiary-bg)                      卡片底色（數值標籤的描邊 halo）

/* ========================= 共用小工具 ========================= */

/** 千分位（固定 en-US 分隔符，三語顯示一致，不受瀏覽器 locale 影響） */
export function formatNumber(n) {
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString('en-US') : '—'
}

// 全形字範圍（CJK、假名、諺文、全形符號）
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/

/** 估算文字在指定字級下的顯示寬度（px；全形 1em、半形 0.55em） */
export function textWidth(text, fontSize) {
  let units = 0
  for (const ch of String(text ?? '')) units += WIDE.test(ch) ? 1 : 0.55
  return units * fontSize
}

/** 超出寬度就截斷並補省略號（SVG 沒有 text-overflow，要自己截） */
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

/** SVG/XML 文字跳脫（曲名可能含 & < > 等字元） */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
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

const C = {
  label: 'var(--bs-secondary-color)',
  muted: 'var(--bs-tertiary-color)',
  grid: 'var(--bs-border-color)',
  halo: 'var(--bs-tertiary-bg)'
}

/* ========================= 橫向排行長條圖 ========================= */

/**
 * @param {object} o
 * @param {Array<{label:string,value:number,hint?:string}>} o.items
 * @param {number} o.width 容器像素寬
 */
export function barChartSVG({
  items = [],
  width = 640,
  color = 'var(--berry-primary)',
  fade = true,
  valueSuffix = '',
  rowHeight = 28,
  labelRatio = 0.34,
  minLabelWidth = 88,
  maxLabelWidth = 260,
  ariaLabel = ''
} = {}) {
  const FONT = 12
  const BAR_H = 13
  const GAP = 10
  const VALUE_W = 60

  const w = Math.max(260, width || 640)
  const labelW = Math.round(Math.min(maxLabelWidth, Math.max(minLabelWidth, w * labelRatio)))
  const trackX = labelW + GAP
  const trackW = Math.max(24, w - labelW - GAP - VALUE_W)
  const height = Math.max(rowHeight, items.length * rowHeight)
  const maxValue = Math.max(1, ...items.map(it => Number(it.value) || 0))

  const body = items.map((it, i) => {
    const value = Number(it.value) || 0
    const label = String(it.label ?? '')
    const short = fitText(label, labelW - 8, FONT)
    const barW = Math.max(2, Math.round((value / maxValue) * trackW))
    const y = i * rowHeight
    // 名次淡出：第一名最實，末位 ~0.58（同色相，仍看得出排序）
    const opacity = fade ? 1 - 0.42 * (i / Math.max(1, items.length - 1)) : 1
    const barY = y + (rowHeight - BAR_H) / 2
    const tip = `${label} — ${formatNumber(value)}${valueSuffix}${it.hint ? ` (${it.hint})` : ''}`
    return `<g><title>${esc(tip)}</title>` +
      `<text x="${labelW}" y="${y + rowHeight / 2}" text-anchor="end" dominant-baseline="central" font-size="${FONT}" fill="${C.label}">${esc(short)}</text>` +
      `<rect x="${trackX}" y="${barY}" width="${trackW}" height="${BAR_H}" rx="3" fill="${C.grid}" opacity="0.35"/>` +
      `<rect x="${trackX}" y="${barY}" width="${barW}" height="${BAR_H}" rx="3" fill="${color}" opacity="${opacity.toFixed(3)}"/>` +
      `<text x="${w}" y="${y + rowHeight / 2}" text-anchor="end" dominant-baseline="central" font-size="${FONT - 1}" fill="${C.muted}" style="font-variant-numeric:tabular-nums">${esc(formatNumber(value) + valueSuffix)}</text>` +
      '</g>'
  }).join('')

  return `<svg viewBox="0 0 ${w} ${height}" style="width:100%;height:${height}px" role="img" aria-label="${esc(ariaLabel)}">${body}</svg>`
}

/* ========================= 直向柱狀圖（類別 x 軸） ========================= */

export function columnChartSVG({
  points = [],
  width = 640,
  color = 'var(--berry-pink)',
  height = 170,
  valueSuffix = '',
  ariaLabel = '',
  showValues = true
} = {}) {
  const FONT = 10
  const VALUE_FONT = 12
  // 開數值標籤時頂部要留字高（最高柱的標籤畫在柱頂上方）
  const PAD = { top: showValues ? 22 : 10, right: 4, bottom: 20, left: 38 }

  const w = Math.max(260, width || 640)
  const plotW = Math.max(20, w - PAD.left - PAD.right)
  const plotH = Math.max(20, height - PAD.top - PAD.bottom)
  const scale = niceScale(Math.max(0, ...points.map(p => Number(p.value) || 0)))
  const band = plotW / Math.max(1, points.length)
  const barW = Math.max(2, Math.min(band * 0.62, 26))
  // x 軸標籤密度：每格至少 46px 才放一個標籤
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 46))))

  // 數值標籤密度：整格放得下就全標；放不下才退成「每 N 個 + 最大值 + 末筆」
  let valueEvery = 1
  if (showValues && points.length) {
    const widest = Math.max(...points.map(p => formatNumber(Number(p.value) || 0).length + valueSuffix.length))
    valueEvery = Math.max(1, Math.ceil((widest * VALUE_FONT * 0.6 + 6) / Math.max(1, band)))
  }
  let peakIndex = -1
  let peakValue = -Infinity
  points.forEach((p, i) => {
    const v = Number(p.value) || 0
    if (v > peakValue) { peakValue = v; peakIndex = i }
  })

  const grid = scale.ticks.map(tick => {
    const y = PAD.top + plotH - (tick / scale.max) * plotH
    return `<line x1="${PAD.left}" x2="${w - PAD.right}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="1" opacity="${tick === 0 ? 0.9 : 0.45}"/>` +
      `<text x="${PAD.left - 6}" y="${y}" text-anchor="end" dominant-baseline="central" font-size="${FONT}" fill="${C.muted}" style="font-variant-numeric:tabular-nums">${formatNumber(tick)}</text>`
  }).join('')

  const bars = points.map((p, i) => {
    const value = Number(p.value) || 0
    const h = Math.max(value > 0 ? 1.5 : 0, (value / scale.max) * plotH)
    const x = PAD.left + band * i + (band - barW) / 2
    const y = PAD.top + plotH - h
    const cx = PAD.left + band * i + band / 2
    const showValue = showValues && (valueEvery === 1 || i % valueEvery === 0 || i === peakIndex || i === points.length - 1)
    let out = `<g><title>${esc(`${p.full ?? p.label} — ${formatNumber(value)}${valueSuffix}`)}</title>` +
      // 透明感應區：整個 band 都能觸發 tooltip，柱子矮時也好指
      `<rect x="${cx - band / 2}" y="${PAD.top}" width="${band}" height="${plotH}" fill="transparent"/>` +
      `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="${color}" opacity="0.9"/></g>`
    if (showValue) {
      // 描邊＝背景色 halo，柱頂貼近格線時數字仍清楚
      out += `<text x="${cx}" y="${y - 5}" text-anchor="middle" font-size="${VALUE_FONT}" fill="${C.muted}" stroke="${C.halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke" style="font-variant-numeric:tabular-nums">${formatNumber(value)}</text>`
    }
    if (i % labelEvery === 0) {
      out += `<text x="${cx}" y="${height - 6}" text-anchor="middle" font-size="${FONT}" fill="${C.muted}">${esc(p.label)}</text>`
    }
    return out
  }).join('')

  return `<svg viewBox="0 0 ${w} ${height}" style="width:100%;height:${height}px" role="img" aria-label="${esc(ariaLabel)}">${grid}${bars}</svg>`
}

/* ========================= 折線／面積圖（類別 x 軸） ========================= */

export function lineChartSVG({
  labels = [],
  series = [],
  fullLabels = null,
  width = 640,
  height = 170,
  area = true,
  valueSuffix = '',
  ariaLabel = '',
  showValues = true
} = {}) {
  const FONT = 10
  const VALUE_FONT = 12
  // 單序列時每個點上方標數值 ⇒ 頂部多留一行字高（多序列標了會互相疊，不標）
  const labelValues = showValues && series.length === 1
  const PAD = { top: labelValues ? 22 : 10, right: 6, bottom: 20, left: 38 }

  const w = Math.max(260, width || 640)
  const plotW = Math.max(20, w - PAD.left - PAD.right)
  const plotH = Math.max(20, height - PAD.top - PAD.bottom)
  const n = Math.max(1, labels.length)
  const band = plotW / n
  const scale = niceScale(Math.max(0, ...series.flatMap(s => (s.values ?? []).map(v => Number(v) || 0))))
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 46))))

  const xAt = (i) => PAD.left + band * i + band / 2
  const yAt = (v) => PAD.top + plotH - ((Number(v) || 0) / scale.max) * plotH

  const grid = scale.ticks.map(tick => {
    const y = PAD.top + plotH - (tick / scale.max) * plotH
    return `<line x1="${PAD.left}" x2="${w - PAD.right}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="1" opacity="${tick === 0 ? 0.9 : 0.45}"/>` +
      `<text x="${PAD.left - 6}" y="${y}" text-anchor="end" dominant-baseline="central" font-size="${FONT}" fill="${C.muted}" style="font-variant-numeric:tabular-nums">${formatNumber(tick)}</text>`
  }).join('')

  const showDots = band >= 12
  const lines = series.map(s => {
    const values = s.values ?? []
    const color = s.color ?? 'var(--berry-primary)'
    const pts = values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
    if (!pts.length) return ''
    const bottom = (PAD.top + plotH).toFixed(1)
    const d = `M${pts.join('L')}`
    const areaD = `M${xAt(0).toFixed(1)},${bottom}L${pts.join('L')}L${xAt(values.length - 1).toFixed(1)},${bottom}Z`
    let out = ''
    if (area && series.length === 1) out += `<path d="${areaD}" fill="${color}" opacity="0.12"/>`
    out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    if (showDots) {
      out += values.map((v, i) =>
        `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="2.6" fill="var(--bs-body-bg)" stroke="${color}" stroke-width="1.6"/>`
      ).join('')
    }
    return out
  }).join('')

  // 一律標在點上方；低谷處折線會從兩側壓過來，所以文字帶背景色描邊（halo）保證可讀
  let valueMarks = ''
  if (labelValues) {
    const values = series[0]?.values ?? []
    const widest = values.length ? Math.max(...values.map(v => formatNumber(Number(v) || 0).length)) : 1
    const valueEvery = Math.max(1, Math.ceil((widest * VALUE_FONT * 0.6 + 6) / Math.max(1, band)))
    let peakIndex = -1
    let peakValue = -Infinity
    values.forEach((v, i) => {
      const num = Number(v) || 0
      if (num > peakValue) { peakValue = num; peakIndex = i }
    })
    valueMarks = values.map((v, i) => {
      if (!(valueEvery === 1 || i % valueEvery === 0 || i === peakIndex || i === values.length - 1)) return ''
      return `<text x="${xAt(i).toFixed(1)}" y="${(yAt(v) - 8).toFixed(1)}" text-anchor="middle" font-size="${VALUE_FONT}" fill="${C.muted}" stroke="${C.halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke" style="font-variant-numeric:tabular-nums">${formatNumber(v)}</text>`
    }).join('')
  }

  // 每個 x 位置一塊透明感應區：hover 顯示該月所有序列的值
  const hover = labels.map((label, i) => {
    const tip = (fullLabels?.[i] ?? label) + series
      .map(s => `\n${s.name ? `${s.name}: ` : ''}${formatNumber(s.values?.[i] ?? 0)}${valueSuffix}`)
      .join('')
    let out = `<rect x="${PAD.left + band * i}" y="${PAD.top}" width="${band}" height="${plotH}" fill="transparent"><title>${esc(tip)}</title></rect>`
    if (i % labelEvery === 0) {
      out += `<text x="${(PAD.left + band * i + band / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="${FONT}" fill="${C.muted}">${esc(label)}</text>`
    }
    return out
  }).join('')

  return `<svg viewBox="0 0 ${w} ${height}" style="width:100%;height:${height}px" role="img" aria-label="${esc(ariaLabel)}">${grid}${lines}${valueMarks}${hover}</svg>`
}

/* ========================= 掛載與重繪 ========================= */

const observers = new WeakMap()

/**
 * 把圖表掛到容器上並跟著容器寬度重繪。
 * @param {HTMLElement} el       圖表容器
 * @param {(width:number)=>string} render  給定像素寬回傳 SVG 字串
 */
export function mountChart(el, render) {
  if (!el) return
  let last = -1
  const draw = () => {
    const w = Math.round(el.clientWidth || el.parentElement?.clientWidth || 0)
    if (w <= 0) return                     // 隱藏中的分頁籤：等變可見再畫
    if (Math.abs(w - last) < 8) return     // 抖動不重畫（捲軸出現等 1~2px 變化）
    last = w
    el.innerHTML = render(w)
  }
  draw()
  observers.get(el)?.disconnect()
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    observers.set(el, ro)
  } else {
    window.addEventListener('resize', draw)
  }
}
