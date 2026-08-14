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
  // 欄位篩選列（桌面 only；手機卡片模式沒有欄的概念，全域搜尋已覆蓋）：
  //   給了 onfilterchange 才會在表頭正下方多一列 sticky 篩選列。欄定義再吃：
  //     filter: 'text'（預設）| 'select' | false（縮圖等裝飾欄由頁面指定 false）
  //     filterValue: (row) => string | string[]   篩選取值，預設 row[key]
  //     filterOptions: {value,label,count}[]      select 用，由頁面以 $derived 提供
  //     filterExact: true                         text 欄改精確比對（段/曲序等數字欄）
  //   與排序同一套分工：DataTable 只出 UI 與值（{ 欄key: 值 }），實際過濾在頁面端做
  //   （才能與全域搜尋、FilterChips 疊成同一個 AND、共用同一次走訪）。
  //   text 欄有 IME 組字防護與 debounce；select 立即生效。
  //   文字框的顯示值是元件內部草稿（drafts），與 columnFilters 單向同步；外部改寫
  //   columnFilters 時由 $effect 回寫進輸入框——但正在輸入／組字／等 debounce 的那一欄
  //   不覆寫（會把使用者打到一半的字吃掉）。
  //   **手機（<768px）不渲染篩選列**（沒有欄的概念），但條件仍在頁面端生效——
  //   縮窗後資料被靜默裁切、找不到出口，故改為顯示一列唯讀提示（幾項生效中＋清除鈕）。
  //   刻意不自動清空：只是把視窗縮窄一下就把桌面辛苦設好的條件丟掉更糟。
  //
  // onedit 有給時，桌面在行尾補一個窄欄放鉛筆鈕；列本身不吃點擊（整列可點會在選取表格文字時誤觸編輯）。
  // **手機不渲染鉛筆**——用戶裁示 2026-08-08「手機＝查資料、PC＝編輯」，四頁通用，各頁不必自己藏。
  //
  // rowActions snippet：行尾（桌面）／卡片右上角（手機）在鉛筆旁再補自訂鈕，例如 StreamList 的「⋯」。
  // 與鉛筆不同，rowActions 手機照樣渲染（查閱類入口）。
  //
  // onrowcontextmenu(row, event)：桌面整列右鍵。DataTable 只負責轉發＋擋掉會誤觸的情境
  // （手機無右鍵、使用者正在選字時讓原生選單走），要不要 preventDefault 由頁面決定。
  //
  // 欄寬拖拉（桌面）：欄頭右緣的把手可拖動改該欄寬度，改過的欄以 px 覆寫 col.width，
  // 未改的欄維持原本的 fr/minmax 定義（因此拖寬一欄＝其餘彈性欄讓出空間）。
  // 刻意不持久化：重整即回到預設欄寬。
  import { untrack } from 'svelte'
  import { t } from '../../i18n.svelte.js'
  import { nextSort, MOBILE_MQ } from './utils.js'

  let {
    rows = [],
    columns = [],
    keyOf = (r, i) => i,
    rowHeight = 66,
    mobileRowHeight = 108,
    minWidth = 780,
    sort = null,
    onsort = undefined,
    /** 目前生效的欄位篩選 { 欄key: 值 }（頁面持有） */
    columnFilters = {},
    /** (next) => void；有給才渲染篩選列（與 sort/onsort 同一套慣例） */
    onfilterchange = undefined,
    /** 文字篩選的 debounce（ms） */
    filterDelay = 150,
    onedit = undefined,
    /** (row, event) — 桌面整列右鍵 */
    onrowcontextmenu = undefined,
    loading = false,
    // 頁面上下留白收斂後（Page.svelte）表格可用高度跟著放大
    height = 'clamp(320px, calc(100dvh - 18rem), 1100px)',
    emptyText = '',
    loadingText = '',
    cell,
    card,
    /** (row) — 行尾/卡片角落的額外動作鈕 */
    rowActions,
  } = $props()

  const HEADER_H = 38
  const FILTER_H = 36
  const OVERSCAN = 6
  const MIN_COL_W = 48
  const ACTION_W_1 = 44
  const ACTION_W_2 = 76

  let scroller = $state(null)
  let scrollTop = $state(0)
  let viewH = $state(600)
  let isMobile = $state(false)
  /** 使用者拖出來的欄寬（key → px）；只存被改過的欄 */
  let colWidths = $state({})
  let resizing = $state(null) // { key, startX, startW }

  const filterMode = (col) => col.filter ?? 'text'

  /** columnFilters 取值：Object.hasOwn 把關，欄 key 撞到 Object.prototype 成員時不誤判成有條件 */
  const filterOf = (key) =>
    columnFilters && Object.hasOwn(columnFilters, key) ? (columnFilters[key] ?? '') : ''
  const draftOf = (key) => (Object.hasOwn(drafts, key) ? (drafts[key] ?? '') : '')

  const rowH = $derived(isMobile ? mobileRowHeight : rowHeight)
  const showFilters = $derived(
    !isMobile && !!onfilterchange && columns.some((c) => filterMode(c) !== false),
  )
  // 表頭＋篩選列都 sticky 在捲動容器頂端，虛擬滾動的起算高度要含兩者
  const headerH = $derived(isMobile ? 0 : HEADER_H + (showFilters ? FILTER_H : 0))
  const activeFilterCount = $derived(
    Object.values(columnFilters ?? {}).filter((v) => v != null && String(v) !== '').length,
  )
  const hasFilterValue = $derived(activeFilterCount > 0)
  /** 手機：篩選列不渲染，改用唯讀提示列當出口（條件仍在頁面端生效，不能不告而別） */
  const showMobileFilterNotice = $derived(isMobile && !!onfilterchange && hasFilterValue)
  const total = $derived(rows.length)
  const bodyTop = $derived(Math.max(0, scrollTop - headerH))
  const start = $derived(Math.max(0, Math.floor(bodyTop / rowH) - OVERSCAN))
  const end = $derived(Math.min(total, Math.ceil((bodyTop + viewH) / rowH) + OVERSCAN))
  const visible = $derived(rows.slice(start, end))
  // 行尾固定窄欄放鉛筆／⋯ 鈕：整列點擊會在選取表格文字時誤觸編輯（回饋 2026-08-08 第三輪回退）
  const hasActionCol = $derived(!!onedit || !!rowActions)
  const ACTION_W = $derived(onedit && rowActions ? ACTION_W_2 : ACTION_W_1)
  const template = $derived(
    columns.map((c) => (colWidths[c.key] ? `${colWidths[c.key]}px` : (c.width ?? '1fr'))).join(' ') +
      (hasActionCol ? ` ${ACTION_W}px` : ''),
  )
  const sortableCols = $derived(columns.filter((c) => c.sortable !== false))

  $effect(() => {
    const mq = window.matchMedia(MOBILE_MQ)
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

  /**
   * 整列右鍵：手機沒有右鍵語意（長按會被當成選字/系統選單）故不攔；
   * 已有選取文字時也放行——使用者正要對選取內容用瀏覽器原生選單。
   */
  function rowContext(e, row) {
    if (!onrowcontextmenu || isMobile) return
    if (window.getSelection?.()?.toString().trim()) return
    onrowcontextmenu(row, e)
  }

  /* ---------- 欄位篩選列 ---------- */
  // 文字框走「本地草稿 + debounce 提交」（同 SearchBox）：15k 列每敲一鍵重算會卡，
  // 且 IME 組字中的片段不該觸發過濾。select 沒有這個問題，change 即提交。
  /** { 欄key: 輸入框當下的字 } */
  let drafts = $state({})
  /** 正在 IME 組字的欄（同一時間只可能有一個輸入框在組字） */
  let composingKey = null
  const filterTimers = new Map()

  $effect(() => () => {
    for (const id of filterTimers.values()) clearTimeout(id)
    filterTimers.clear()
  })

  /** columnFilters 想要的文字框內容（只算 text 欄；select 直接綁 columnFilters 不需草稿） */
  const desiredDrafts = $derived.by(() => {
    const out = {}
    for (const col of columns) {
      if (filterMode(col) !== 'text') continue
      out[col.key] = String(filterOf(col.key))
    }
    return out
  })

  // 單向同步的回程：頁面／提示列改寫 columnFilters 後，輸入框顯示值要跟著回來
  // （不然「清除」按了條件沒了、框裡的字還在）。三種情況不覆寫：
  // 該欄正在被輸入（聚焦中）、IME 組字中、debounce 還沒送出——都會搶掉使用者打的字。
  $effect(() => {
    const want = desiredDrafts
    untrack(() => {
      let next = null
      for (const key of Object.keys(want)) {
        if (want[key] === String(draftOf(key))) continue
        if (composingKey === key || filterTimers.has(key)) continue
        if (document.activeElement?.dataset?.filter === key) continue
        next ??= { ...drafts }
        next[key] = want[key]
      }
      if (next) drafts = next
    })
  })

  function commitFilter(key, value) {
    const next = { ...columnFilters }
    const v = String(value ?? '').trim()
    if (v) next[key] = v
    else delete next[key]
    onfilterchange?.(next)
  }

  function scheduleFilter(key, value) {
    clearTimeout(filterTimers.get(key))
    filterTimers.delete(key)
    if (composingKey === key) return // 組字中不送出
    // 送出後把自己從表上移除：filterTimers.has(key)＝「這一欄還有沒送出的輸入」，
    // 上面的草稿回寫 effect 靠它判斷該不該讓路
    filterTimers.set(
      key,
      setTimeout(() => {
        filterTimers.delete(key)
        commitFilter(key, value)
      }, filterDelay),
    )
  }

  function onFilterInput(col, e) {
    const v = e.currentTarget.value
    drafts = { ...drafts, [col.key]: v }
    scheduleFilter(col.key, v)
  }

  function onFilterCompositionEnd(col, e) {
    composingKey = null
    const v = e.currentTarget.value
    drafts = { ...drafts, [col.key]: v }
    scheduleFilter(col.key, v)
  }

  function clearFilter(key) {
    clearTimeout(filterTimers.get(key))
    filterTimers.delete(key)
    drafts = { ...drafts, [key]: '' }
    commitFilter(key, '')
  }

  function clearAllFilters() {
    for (const id of filterTimers.values()) clearTimeout(id)
    filterTimers.clear()
    drafts = {}
    onfilterchange?.({})
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

{#snippet clearAllBtn()}
  <button
    type="button"
    class="rounded p-1 transition-colors hover:text-[var(--berry-primary)]"
    style="color: var(--berry-text-emphasis)"
    aria-label={t('common.clearColumnFilters')}
    title={t('common.clearColumnFilters')}
    onclick={clearAllFilters}
  >
    <!-- 漏斗加斜線＝解除篩選 -->
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
      <path d="M4 5h16l-6 7v5.5l-4 2V12z" />
      <path d="M4 20L20 4" />
    </svg>
  </button>
{/snippet}

<div class="rounded-lg border border-berry-border bg-berry-bg">
  <!-- 手機：篩選列不渲染，但條件照樣生效——出一列唯讀提示＋清除鈕當出口 -->
  {#if showMobileFilterNotice}
    <div
      class="flex items-center gap-2 border-b border-berry-border px-3 py-2 text-sm"
      style="background: var(--berry-subtle-bg); color: var(--berry-text-emphasis)"
      role="status"
    >
      <span class="min-w-0 flex-1">
        {t('common.columnFiltersActive', { n: activeFilterCount })}
      </span>
      <button
        type="button"
        class="shrink-0 rounded-md border px-2 py-1 text-sm transition-colors hover:bg-berry-bg-3"
        style="border-color: var(--berry-subtle-border)"
        onclick={clearAllFilters}
      >
        ✕ {t('common.clear')}
      </button>
    </div>
  {/if}

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
          {#if hasActionCol}
            <div aria-hidden="true"></div>
          {/if}
        </div>
      {/if}

      {#if showFilters}
        <!-- 篩選列：跟著表頭一起 sticky（top = 表頭高）。背景與表頭同色，
             兩者之間靠表頭自己的 border-b 分隔，讀起來是同一塊固定區。 -->
        <div
          class="sticky z-10 grid border-b border-berry-border bg-berry-bg-2"
          style="top: {HEADER_H}px; grid-template-columns: {template}; height: {FILTER_H}px"
          role="row"
        >
          {#each columns as col (col.key)}
            <div class="flex min-w-0 items-center px-1.5">
              {#if filterMode(col) === 'select'}
                <select
                  class="h-7 w-full min-w-0 rounded border border-berry-border bg-berry-bg-3 px-1 text-sm text-berry-fg outline-none focus:border-[var(--berry-primary)]"
                  style={filterOf(col.key) ? 'border-color: var(--berry-primary)' : ''}
                  aria-label={t('common.filterColumn', { label: col.label })}
                  title={t('common.filterColumn', { label: col.label })}
                  value={filterOf(col.key)}
                  onchange={(e) => commitFilter(col.key, e.currentTarget.value)}
                >
                  <option value="">{t('common.all')}</option>
                  {#each col.filterOptions ?? [] as opt (opt.value)}
                    <option value={opt.value}>
                      {opt.label}{opt.count != null ? ` (${opt.count})` : ''}
                    </option>
                  {/each}
                </select>
              {:else if filterMode(col) !== false}
                <div class="relative min-w-0 flex-1">
                  <input
                    type="text"
                    class="h-7 w-full min-w-0 rounded border border-berry-border bg-berry-bg-3 pl-1.5 text-sm text-berry-fg outline-none transition-colors placeholder:text-berry-fg-3 focus:border-[var(--berry-primary)] {draftOf(
                      col.key,
                    )
                      ? 'pr-5'
                      : 'pr-1.5'}"
                    style={filterOf(col.key) ? 'border-color: var(--berry-primary)' : ''}
                    placeholder={col.label}
                    aria-label={t('common.filterColumn', { label: col.label })}
                    title={t('common.filterColumn', { label: col.label })}
                    data-filter={col.key}
                    value={draftOf(col.key)}
                    oninput={(e) => onFilterInput(col, e)}
                    oncompositionstart={() => (composingKey = col.key)}
                    oncompositionend={(e) => onFilterCompositionEnd(col, e)}
                  />
                  {#if draftOf(col.key)}
                    <button
                      type="button"
                      class="absolute right-0.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-berry-fg-3 transition-colors hover:text-berry-fg"
                      aria-label={t('common.clear')}
                      title={t('common.clear')}
                      onclick={() => clearFilter(col.key)}
                    >
                      <svg
                        class="size-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.6"
                        aria-hidden="true"
                      >
                        <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
                      </svg>
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}

          {#if hasActionCol}
            <!-- 行尾動作欄的位置不放篩選輸入，只在有條件時放「清除欄位篩選」。
                 ⚠️ 沒有行尾動作欄的表格就沒有這個出口——原本的退路是絕對定位貼在
                 min-width 畫布右緣，橫向捲動時會躲到視窗外（比沒有更糟），已移除。
                 四張表都有動作欄故走不到；日後真有無動作欄的表格，請在工具列另給清除入口。 -->
            <div class="flex items-center justify-center">
              {#if hasFilterValue}
                {@render clearAllBtn()}
              {/if}
            </div>
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
              <!-- 右鍵是滑鼠專屬的便利入口，列本身不進 Tab 序；鍵盤／無障礙走行尾的鈕 -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_interactive_supports_focus -->
              <div
                class="group relative border-b border-berry-border transition-colors hover:bg-berry-bg-3"
                style="height: {rowH}px"
                role="row"
                oncontextmenu={onrowcontextmenu ? (e) => rowContext(e, row) : undefined}
              >
                {#if isMobile}
                  <!-- 右側留白給動作鈕，長標題才不會被蓋住 -->
                  <div class="flex h-full items-center px-3 {rowActions ? 'pr-10' : ''}">
                    <div class="min-w-0 flex-1 overflow-hidden">
                      {@render card?.(row)}
                    </div>
                  </div>
                  {#if rowActions}
                    <!-- 卡片右上角：卡片本體不吃點擊，避免選字誤觸。
                         手機不放鉛筆（唯讀），只留查閱類的自訂動作鈕。 -->
                    <div class="absolute right-1.5 top-1.5 flex items-center">
                      {@render rowActions(row)}
                    </div>
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
                    {#if hasActionCol}
                      <div class="flex items-center justify-center gap-0.5">
                        {#if onedit}
                          <button
                            type="button"
                            class="rounded p-1.5 text-berry-fg-3 opacity-80 transition group-hover:opacity-100 hover:text-[var(--berry-primary)]"
                            aria-label={t('common.edit')}
                            title={t('common.edit')}
                            onclick={() => onedit(row)}
                          >
                            {@render pencil()}
                          </button>
                        {/if}
                        {@render rowActions?.(row)}
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
