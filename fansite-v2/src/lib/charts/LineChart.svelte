<script>
  // 折線／面積圖（類別 x 軸，例如月份）。多序列共用同一 y 尺度（不做雙軸，避免誤讀）。
  import { formatNumber, niceScale } from './format.js'

  /**
   * @type {{
   *   labels: string[],
   *   series: Array<{ name?: string, color?: string, values: number[] }>,
   *   fullLabels?: string[], height?: number, area?: boolean,
   *   valueSuffix?: string, ariaLabel?: string,
   * }}
   */
  let {
    labels = [],
    series = [],
    fullLabels = null,
    height = 170,
    area = true,
    valueSuffix = '',
    ariaLabel = '',
    showValues = true,
  } = $props()

  const FONT = 10
  const VALUE_FONT = 12

  let width = $state(0)

  // 單序列時每個點上方標數值 ⇒ 頂部要多留一行字高（多序列標了會互相疊，不標）
  const labelValues = $derived(showValues && series.length === 1)
  const PAD = $derived({ top: labelValues ? 22 : 10, right: 6, bottom: 20, left: 38 })

  const w = $derived(Math.max(260, width || 640))
  const plotW = $derived(Math.max(20, w - PAD.left - PAD.right))
  const plotH = $derived(Math.max(20, height - PAD.top - PAD.bottom))
  const n = $derived(Math.max(1, labels.length))
  const band = $derived(plotW / n)
  const scale = $derived(
    niceScale(Math.max(0, ...series.flatMap((s) => (s.values ?? []).map((v) => Number(v) || 0)))),
  )
  const labelEvery = $derived(Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 46)))))

  const xAt = (i) => PAD.left + band * i + band / 2
  const yAt = (v) => PAD.top + plotH - ((Number(v) || 0) / scale.max) * plotH

  const lines = $derived(
    series.map((s) => {
      const values = s.values ?? []
      const pts = values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
      const bottom = (PAD.top + plotH).toFixed(1)
      return {
        name: s.name ?? '',
        color: s.color ?? 'var(--berry-primary)',
        values,
        d: pts.length ? `M${pts.join('L')}` : '',
        areaD: pts.length
          ? `M${xAt(0).toFixed(1)},${bottom}L${pts.join('L')}L${xAt(values.length - 1).toFixed(1)},${bottom}Z`
          : '',
        dots: values.map((v, i) => ({ x: xAt(i), y: yAt(v), v })),
      }
    }),
  )

  const showDots = $derived(band >= 12)
  const hasLegend = $derived(series.some((s) => s.name))

  // 數值標籤密度：整格放得下就全標；否則退成「每 N 個 + 最大值 + 末筆」
  const valueEvery = $derived.by(() => {
    const values = series[0]?.values ?? []
    if (!labelValues || !values.length) return 1
    const widest = Math.max(...values.map((v) => formatNumber(Number(v) || 0).length))
    return Math.max(1, Math.ceil((widest * VALUE_FONT * 0.6 + 6) / Math.max(1, band)))
  })
  const peakIndex = $derived.by(() => {
    const values = series[0]?.values ?? []
    let best = -1
    let bestValue = -Infinity
    values.forEach((v, i) => {
      const num = Number(v) || 0
      if (num > bestValue) {
        bestValue = num
        best = i
      }
    })
    return best
  })
  // 一律標在點上方；低谷處折線會從兩側壓過來，所以文字帶背景色描邊（halo）保證可讀
  const valueLabels = $derived.by(() => {
    const dots = labelValues ? (lines[0]?.dots ?? []) : []
    return dots
      .map((dot, i) => ({ ...dot, i, y: dot.y - 8 }))
      .filter(
        ({ i }) =>
          valueEvery === 1 || i % valueEvery === 0 || i === peakIndex || i === dots.length - 1,
      )
  })
</script>

{#if hasLegend}
  <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-berry-fg-3">
    {#each series as s}
      <span class="inline-flex items-center gap-1.5">
        <span
          class="inline-block size-2 rounded-full"
          style={`background:${s.color ?? 'var(--berry-primary)'}`}
        ></span>
        {s.name}
      </span>
    {/each}
  </div>
{/if}

<div bind:clientWidth={width} class="w-full" style={`min-height:${height}px`}>
  <svg
    viewBox={`0 0 ${w} ${height}`}
    style={`width:100%;height:${height}px`}
    role="img"
    aria-label={ariaLabel}
  >
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

    {#each lines as line}
      {#if area && lines.length === 1}
        <path d={line.areaD} fill={line.color} opacity="0.12" />
      {/if}
      <path
        d={line.d}
        fill="none"
        stroke={line.color}
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      {#if showDots}
        {#each line.dots as dot}
          <circle
            cx={dot.x}
            cy={dot.y}
            r="2.6"
            fill="var(--berry-bg)"
            stroke={line.color}
            stroke-width="1.6"
          />
        {/each}
      {/if}
    {/each}

    {#each valueLabels as dot (dot.i)}
      <text
        x={dot.x}
        y={dot.y}
        text-anchor="middle"
        font-size={VALUE_FONT}
        fill="var(--berry-fg-3)"
        stroke="var(--berry-bg-3)"
        stroke-width="3"
        stroke-linejoin="round"
        paint-order="stroke"
        style="font-variant-numeric: tabular-nums"
      >
        {formatNumber(dot.v)}
      </text>
    {/each}

    <!-- 每個 x 位置一塊透明感應區：hover 顯示該月所有序列的值 -->
    {#each labels as label, i}
      <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="transparent">
        <title
          >{fullLabels?.[i] ?? label}{series
            .map((s) => `\n${s.name ? `${s.name}: ` : ''}${formatNumber(s.values?.[i] ?? 0)}${valueSuffix}`)
            .join('')}</title
        >
      </rect>
      {#if i % labelEvery === 0}
        <text
          x={PAD.left + band * i + band / 2}
          y={height - 6}
          text-anchor="middle"
          font-size={FONT}
          fill="var(--berry-fg-3)"
        >
          {label}
        </text>
      {/if}
    {/each}
  </svg>
</div>
