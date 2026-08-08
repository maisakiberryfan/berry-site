<script>
  // 直向柱狀圖（類別 x 軸，例如月份）。響應式策略同 BarChart：viewBox 寬 = 容器 px 寬。
  import { formatNumber, niceScale } from './format.js'

  /**
   * @type {{
   *   points: Array<{ label: string, value: number, full?: string }>,
   *   color?: string, height?: number, valueSuffix?: string, ariaLabel?: string,
   * }}
   */
  let {
    points = [],
    color = 'var(--berry-pink)',
    height = 170,
    valueSuffix = '',
    ariaLabel = '',
    showValues = true,
  } = $props()

  const FONT = 10
  const VALUE_FONT = 12

  let width = $state(0)

  // 開數值標籤時頂部要留字高（最高柱的標籤畫在柱頂上方）
  const PAD = $derived({ top: showValues ? 22 : 10, right: 4, bottom: 20, left: 38 })

  const w = $derived(Math.max(260, width || 640))
  const plotW = $derived(Math.max(20, w - PAD.left - PAD.right))
  const plotH = $derived(Math.max(20, height - PAD.top - PAD.bottom))
  const scale = $derived(niceScale(Math.max(0, ...points.map((p) => Number(p.value) || 0))))
  const band = $derived(plotW / Math.max(1, points.length))
  const barW = $derived(Math.max(2, Math.min(band * 0.62, 26)))
  // x 軸標籤密度：每格至少 46px 才放一個標籤
  const labelEvery = $derived(
    Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 46)))),
  )

  // 數值標籤密度：整格放得下就全標；放不下才退成「每 N 個 + 最大值 + 末筆」
  const valueEvery = $derived.by(() => {
    if (!showValues || !points.length) return 1
    const widest = Math.max(
      ...points.map((p) => formatNumber(Number(p.value) || 0).length + valueSuffix.length),
    )
    const textW = widest * VALUE_FONT * 0.6
    return Math.max(1, Math.ceil((textW + 6) / Math.max(1, band)))
  })
  const peakIndex = $derived.by(() => {
    let best = -1
    let bestValue = -Infinity
    points.forEach((p, i) => {
      const v = Number(p.value) || 0
      if (v > bestValue) {
        bestValue = v
        best = i
      }
    })
    return best
  })

  const bars = $derived(
    points.map((p, i) => {
      const value = Number(p.value) || 0
      const h = Math.max(value > 0 ? 1.5 : 0, (value / scale.max) * plotH)
      return {
        ...p,
        value,
        x: PAD.left + band * i + (band - barW) / 2,
        y: PAD.top + plotH - h,
        h,
        cx: PAD.left + band * i + band / 2,
        showLabel: i % labelEvery === 0,
        showValue:
          showValues &&
          (valueEvery === 1 ||
            i % valueEvery === 0 ||
            i === peakIndex ||
            i === points.length - 1),
      }
    }),
  )
</script>

<div bind:clientWidth={width} class="w-full" style={`min-height:${height}px`}>
  <svg
    viewBox={`0 0 ${w} ${height}`}
    style={`width:100%;height:${height}px`}
    role="img"
    aria-label={ariaLabel}
  >
    <!-- 水平格線（極淡）＋ y 刻度 -->
    {#each scale.ticks as tick}
      {@const y = PAD.top + plotH - (tick / scale.max) * plotH}
      <line
        x1={PAD.left}
        x2={w - PAD.right}
        y1={y}
        y2={y}
        stroke="var(--berry-border)"
        stroke-width="1"
        opacity={tick === 0 ? 0.9 : 0.45}
      />
      <text
        x={PAD.left - 6}
        y={y}
        text-anchor="end"
        dominant-baseline="central"
        font-size={FONT}
        fill="var(--berry-fg-3)"
        style="font-variant-numeric: tabular-nums"
      >
        {formatNumber(tick)}
      </text>
    {/each}

    {#each bars as bar}
      <g>
        <title>{bar.full ?? bar.label} — {formatNumber(bar.value)}{valueSuffix}</title>
        <!-- 透明感應區：整個 band 都能觸發 tooltip，柱子矮時也好指 -->
        <rect
          x={bar.cx - band / 2}
          y={PAD.top}
          width={band}
          height={plotH}
          fill="transparent"
        />
        <rect x={bar.x} y={bar.y} width={barW} height={bar.h} rx="3" fill={color} opacity="0.9" />
      </g>
      {#if bar.showValue}
        <!-- 描邊＝背景色 halo，柱頂貼近格線時數字仍清楚 -->
        <text
          x={bar.cx}
          y={bar.y - 5}
          text-anchor="middle"
          font-size={VALUE_FONT}
          fill="var(--berry-fg-3)"
          stroke="var(--berry-bg-3)"
          stroke-width="3"
          stroke-linejoin="round"
          paint-order="stroke"
          style="font-variant-numeric: tabular-nums"
        >
          {formatNumber(bar.value)}
        </text>
      {/if}
      {#if bar.showLabel}
        <text
          x={bar.cx}
          y={height - 6}
          text-anchor="middle"
          font-size={FONT}
          fill="var(--berry-fg-3)"
        >
          {bar.label}
        </text>
      {/if}
    {/each}
  </svg>
</div>
