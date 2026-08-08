<script>
  // 虛擬滾動表格（桌面 ≥768px 表格 / 手機卡片列）。
  //
  // 為什麼不用 <table>：15k 列必須視窗化，固定行高 + CSS grid 的欄寬對齊比 table 好控制，
  // 表頭 sticky 在同一個捲動容器內，水平捲動時自然對齊。
  //
  // 用法：
  //   <DataTable {rows} {columns} keyOf={...} {sort} onsort={(s) => (sort = s)} onedit={...}>
  //     {#snippet cell(row, col)} … {/snippet}
  //     {#snippet card(row)} … {/snippet}
  //   </DataTable>
  //
  // columns: [{ key, label, width: '1fr'|'80px', sortable?: boolean, sortValue?: (row)=>any, align?: 'right'|'center' }]
  // 排序本身由頁面負責（applySort），DataTable 只負責欄頭互動與指示箭頭。
  //
  // onedit 有給時，桌面在行尾補一個 44px 窄欄放鉛筆鈕、手機在卡片右上角放鉛筆鈕；
  // 列本身不吃點擊（整列可點會在選取表格文字時誤觸編輯）。
  //
  // 欄寬拖拉（桌面）：欄頭右緣的把手可拖動改該欄寬度，改過的欄以 px 覆寫 col.width，
  // 未改的欄維持原本的 fr/minmax 定義（因此拖寬一欄＝其餘彈性欄讓出空間）。
  // 刻意不持久化：重整即回到預設欄寬。
  import { t } from '../../i18n.svelte.js'
  import { nextSort } from './utils.js'

  let {
    rows = [],
    columns = [],
    keyOf = (r, i) => i,
    rowHeight = 66,
    mobileRowHeight = 108,
    minWidth = 780,
    sort = null,
    onsort = undefined,
    onedit = undefined,
    loading = false,
    // 頁面上下留白收斂後（Page.svelte）表格可用高度跟著放大
    height = 'clamp(320px, calc(100dvh - 18rem), 1100px)',
    emptyText = '',
    loadingText = '',
    cell,
    card,
  } = $props()

  const HEADER_H = 38
  const OVERSCAN = 6
  const MIN_COL_W = 48

  let scroller = $state(null)
  let scrollTop = $state(0)
  let viewH = $state(600)
  let isMobile = $state(false)
  /** 使用者拖出來的欄寬（key → px）；只存被改過的欄 */
  let colWidths = $state({})
  let resizing = $state(null) // { key, startX, startW }

  const rowH = $derived(isMobile ? mobileRowHeight : rowHeight)
  const headerH = $derived(isMobile ? 0 : HEADER_H)
  const total = $derived(rows.length)
  const bodyTop = $derived(Math.max(0, scrollTop - headerH))
  const start = $derived(Math.max(0, Math.floor(bodyTop / rowH) - OVERSCAN))
  const end = $derived(Math.min(total, Math.ceil((bodyTop + viewH) / rowH) + OVERSCAN))
  const visible = $derived(rows.slice(start, end))
  // 行尾固定窄欄放鉛筆鈕：整列點擊會在選取表格文字時誤觸編輯（回饋 2026-08-08 第三輪回退）
  const ACTION_W = 44
  const template = $derived(
    columns.map((c) => (colWidths[c.key] ? `${colWidths[c.key]}px` : (c.width ?? '1fr'))).join(' ') +
      (onedit ? ` ${ACTION_W}px` : ''),
  )
  const sortableCols = $derived(columns.filter((c) => c.sortable !== false))

  $effect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const apply = () => (isMobile = mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  })

  $effect(() => {
    const el = scroller
    if (!el) return
    viewH = el.clientHeight
    const ro = new ResizeObserver(() => (viewH = el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  })

  // 列數變少（篩選）時把捲動位置夾回合法範圍，避免停在空白區
  $effect(() => {
    const el = scroller
    const max = Math.max(0, total * rowH + headerH - viewH)
    if (el && el.scrollTop > max) {
      el.scrollTop = max
      scrollTop = max
    }
  })

  function onScroll(e) {
    scrollTop = e.currentTarget.scrollTop
  }

  function headerClick(col) {
    if (col.sortable === false || !onsort) return
    onsort(nextSort(sort, col.key))
  }

  /* ---------- 欄寬拖拉 ---------- */
  // 起始寬度量測自欄頭實際渲染寬（fr/minmax 也能拿到 px），拖拉期間用 pointer capture
  // 讓 move/up 都回到把手身上，不必掛 document 監聽。
  function startResize(e, col) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation() // 不讓 pointerdown 冒到欄頭（排序）
    const head = e.currentTarget.parentElement
    resizing = {
      key: col.key,
      startX: e.clientX,
      startW: head ? head.getBoundingClientRect().width : MIN_COL_W,
    }
    // capture 失敗（少見）也要照常拖，只是滑出把手範圍會斷
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {}
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  function moveResize(e) {
    if (!resizing) return
    const w = Math.max(MIN_COL_W, Math.round(resizing.startW + (e.clientX - resizing.startX)))
    colWidths = { ...colWidths, [resizing.key]: w }
  }

  function endResize(e) {
    if (!resizing) return
    resizing = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {}
  }
</script>

{#snippet pencil()}
  <svg
    class="size-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4.5 19.5h4l9.6-9.6a2.55 2.55 0 0 0-3.6-3.6l-9.6 9.6v3.6z" />
    <path d="M13.2 7.2l3.6 3.6" />
  </svg>
{/snippet}

<div class="rounded-lg border border-berry-border bg-berry-bg">
  <!-- 手機：欄頭消失，改用緊湊排序控制 -->
  {#if isMobile && sortableCols.length && onsort}
    <div class="flex items-center gap-2 border-b border-berry-border px-3 py-2">
      <span class="text-sm text-berry-fg-3" aria-hidden="true">⇅</span>
      <select
        class="min-w-0 flex-1 rounded-md border border-berry-border bg-berry-bg-3 px-2 py-1 text-sm text-berry-fg outline-none"
        value={sort?.key ?? ''}
        onchange={(e) => {
          const key = e.currentTarget.value
          onsort(key ? { key, dir: sort?.dir ?? 'asc' } : null)
        }}
      >
        <option value="">{t('common.none')}</option>
        {#each sortableCols as col (col.key)}
          <option value={col.key}>{col.label}</option>
        {/each}
      </select>
      <button
        type="button"
        class="rounded-md border border-berry-border bg-berry-bg-3 px-2 py-1 text-sm text-berry-fg-2 disabled:opacity-40"
        disabled={!sort?.key}
        onclick={() => onsort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
      >
        {sort?.dir === 'desc' ? '↓' : '↑'}
      </button>
    </div>
  {/if}

  <div
    bind:this={scroller}
    class="relative overflow-auto overscroll-contain"
    style="height: {height}"
    onscroll={onScroll}
  >
    <div style={isMobile ? '' : `min-width: ${minWidth}px`}>
      {#if !isMobile}
        <div
          class="sticky top-0 z-10 grid border-b border-berry-border bg-berry-bg-2"
          style="grid-template-columns: {template}; height: {HEADER_H}px"
          role="row"
        >
          {#each columns as col (col.key)}
            <div
              class="relative flex min-w-0 items-center px-3 text-base font-medium text-berry-fg-2 {col.align ===
              'right'
                ? 'justify-end'
                : col.align === 'center'
                  ? 'justify-center'
                  : ''}"
            >
              {#if col.sortable === false || !onsort}
                <span class="truncate">{col.label}</span>
              {:else}
                <button
                  type="button"
                  class="inline-flex min-w-0 items-center gap-1 rounded transition-colors hover:text-berry-fg"
                  onclick={() => headerClick(col)}
                >
                  <span class="truncate">{col.label}</span>
                  <span
                    class="text-[10px] leading-none"
                    style={sort?.key === col.key ? 'color: var(--berry-primary)' : 'opacity:.35'}
                  >
                    {sort?.key === col.key ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                  </span>
                </button>
              {/if}

              <!-- 欄寬拖把手：tabindex -1（無鍵盤語意，不進 Tab 序） -->
              <button
                type="button"
                tabindex="-1"
                data-resize-handle={col.key}
                aria-label={t('common.resizeColumn')}
                class="group/rs absolute right-0 top-0 z-20 flex h-full w-1.5 cursor-col-resize touch-none items-center justify-center"
                onpointerdown={(e) => startResize(e, col)}
                onpointermove={moveResize}
                onpointerup={endResize}
                onpointercancel={endResize}
                onclick={(e) => e.stopPropagation()}
              >
                <span
                  class="h-4 w-px transition-colors group-hover/rs:bg-berry-border"
                  style={resizing?.key === col.key ? 'background: var(--berry-primary)' : ''}
                ></span>
              </button>
            </div>
          {/each}
          {#if onedit}
            <div aria-hidden="true"></div>
          {/if}
        </div>
      {/if}

      {#if total === 0}
        <div class="flex h-40 items-center justify-center px-4 text-sm text-berry-fg-3">
          {loading ? loadingText || t('common.loadingData') : emptyText || t('common.noResults')}
        </div>
      {:else}
        <div style="height: {total * rowH}px; position: relative">
          <div
            style="position:absolute; left:0; right:0; top:0; transform: translateY({start *
              rowH}px); will-change: transform"
          >
            {#each visible as row, i (keyOf(row, start + i))}
              <div
                class="group relative border-b border-berry-border transition-colors hover:bg-berry-bg-3"
                style="height: {rowH}px"
                role="row"
              >
                {#if isMobile}
                  <!-- 右側留白給鉛筆鈕，長標題才不會被蓋住 -->
                  <div class="flex h-full items-center px-3 {onedit ? 'pr-10' : ''}">
                    <div class="min-w-0 flex-1 overflow-hidden">
                      {@render card?.(row)}
                    </div>
                  </div>
                  {#if onedit}
                    <!-- 卡片右上角：卡片本體不吃點擊，避免選字誤觸 -->
                    <button
                      type="button"
                      class="absolute right-1.5 top-1.5 rounded p-1.5 text-berry-fg-3 transition-colors hover:text-[var(--berry-primary)]"
                      aria-label={t('common.edit')}
                      onclick={() => onedit(row)}
                    >
                      {@render pencil()}
                    </button>
                  {/if}
                {:else}
                  <div class="grid h-full" style="grid-template-columns: {template}">
                    {#each columns as col (col.key)}
                      <!-- overflow-hidden：欄寬被拖窄時內容（如縮圖）不會溢到隔壁欄 -->
                      <div
                        class="flex min-w-0 flex-col justify-center overflow-hidden px-3 text-base {col.align ===
                        'right'
                          ? 'items-end text-right'
                          : col.align === 'center'
                            ? 'items-center text-center'
                            : ''}"
                      >
                        {@render cell?.(row, col)}
                      </div>
                    {/each}
                    {#if onedit}
                      <div class="flex items-center justify-center">
                        <button
                          type="button"
                          class="rounded p-1.5 text-berry-fg-3 opacity-80 transition group-hover:opacity-100 hover:text-[var(--berry-primary)]"
                          aria-label={t('common.edit')}
                          title={t('common.edit')}
                          onclick={() => onedit(row)}
                        >
                          {@render pencil()}
                        </button>
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
