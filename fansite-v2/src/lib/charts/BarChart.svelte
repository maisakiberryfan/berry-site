<script>
  // 橫向排行長條圖（自繪 SVG，無外部圖表庫）
  //
  // 響應式做法：量測容器寬度後讓 viewBox 寬度 = 容器 px 寬（1 unit = 1px），
  // 這樣字級永遠是真實 px，不會像固定 viewBox 那樣在手機上被縮成看不清。
  // 色彩：單一色相 + 名次淡出（禁彩虹），全部走 CSS 變數，亮暗主題共用。
  import { formatNumber, fitText } from './format.js'

  /**
   * @type {{
   *   items: Array<{ label: string, value: number, hint?: string }>,
   *   color?: string, fade?: boolean, valueSuffix?: string,
   *   rowHeight?: number, labelRatio?: number, minLabelWidth?: number, maxLabelWidth?: number,
   *   ariaLabel?: string,
   * }}
   */
  let {
    items = [],
    color = 'var(--berry-primary)',
    fade = true,
    valueSuffix = '',
    rowHeight = 28,
    labelRatio = 0.34,
    minLabelWidth = 88,
    maxLabelWidth = 260,
    ariaLabel = '',
  } = $props()

  const FONT = 12
  const BAR_H = 13
  const GAP = 10
  const VALUE_W = 60

  let width = $state(0)

  const w = $derived(Math.max(260, width || 640))
  const labelW = $derived(
    Math.round(Math.min(maxLabelWidth, Math.max(minLabelWidth, w * labelRatio))),
  )
  const trackX = $derived(labelW + GAP)
  const trackW = $derived(Math.max(24, w - labelW - GAP - VALUE_W))
  const height = $derived(Math.max(rowHeight, items.length * rowHeight))
  const maxValue = $derived(Math.max(1, ...items.map((it) => Number(it.value) || 0)))

  const rows = $derived(
    items.map((it, i) => {
      const value = Number(it.value) || 0
      return {
        label: String(it.label ?? ''),
        hint: it.hint ?? '',
        value,
        short: fitText(String(it.label ?? ''), labelW - 8, FONT),
        barW: Math.max(2, Math.round((value / maxValue) * trackW)),
        y: i * rowHeight,
        // 名次淡出：第一名最實，末位 ~0.58（同色相，仍看得出排序）
        opacity: fade ? 1 - 0.42 * (i / Math.max(1, items.length - 1)) : 1,
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
    {#each rows as row}
      <g>
        <title>{row.label} — {formatNumber(row.value)}{valueSuffix}{row.hint ? ` (${row.hint})` : ''}</title>

        <!-- 標籤（右對齊貼齊長條起點） -->
        <text
          x={labelW}
          y={row.y + rowHeight / 2}
          text-anchor="end"
          dominant-baseline="central"
          font-size={FONT}
          fill="var(--berry-fg-2)"
        >
          {row.short}
        </text>

        <!-- 軌道（極淡，僅暗示滿格） -->
        <rect
          x={trackX}
          y={row.y + (rowHeight - BAR_H) / 2}
          width={trackW}
          height={BAR_H}
          rx="3"
          fill="var(--berry-border)"
          opacity="0.35"
        />

        <rect
          x={trackX}
          y={row.y + (rowHeight - BAR_H) / 2}
          width={row.barW}
          height={BAR_H}
          rx="3"
          fill={color}
          opacity={row.opacity}
        />

        <text
          x={w}
          y={row.y + rowHeight / 2}
          text-anchor="end"
          dominant-baseline="central"
          font-size={FONT - 1}
          fill="var(--berry-fg-3)"
          style="font-variant-numeric: tabular-nums"
        >
          {`${formatNumber(row.value)}${valueSuffix}`}
        </text>
      </g>
    {/each}
  </svg>
</div>
