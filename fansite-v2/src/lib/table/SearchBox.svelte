<script>
  // 全文搜尋框：300ms debounce、IME 組字中不觸發、清除鈕
  // 另有可選的「?」語法說明 popover：頁面傳 helpFields（欄位語法清單）與 helpExamples 即出現
  import { t, getLang } from '../../i18n.svelte.js'

  let {
    value = $bindable(''),
    placeholder = '',
    delay = 300,
    onchange = undefined,
    /** [{ syntax: '歌手 / artist', label: '歌手' }]；為空＝不顯示說明鈕 */
    helpFields = null,
    /** 範例查詢字串陣列 */
    helpExamples = null,
  } = $props()

  let draft = $state(value)
  let composing = false
  let timer = null

  function flush() {
    value = draft
    onchange?.(draft)
  }

  function schedule() {
    clearTimeout(timer)
    if (composing) return // IME 組字中不送出（否則中途片段會觸發整表重算）
    timer = setTimeout(flush, delay)
  }

  function onInput(e) {
    draft = e.currentTarget.value
    schedule()
  }

  function onCompositionEnd(e) {
    composing = false
    draft = e.currentTarget.value
    schedule()
  }

  /**
   * 組字中途離開輸入框時 compositionend 不保證會來（各 IME 行為不一）。
   * 旗標卡在 true 的話之後每一次輸入都會被當成組字中間態而不送出——
   * 使用者看到的是「搜尋框打字沒反應」。blur 一律歸零並補送目前的字。
   */
  function onBlur(e) {
    if (!composing) return
    composing = false
    draft = e.currentTarget.value
    schedule()
  }

  function clear() {
    clearTimeout(timer)
    draft = ''
    flush()
  }

  $effect(() => () => clearTimeout(timer))

  /* ---------- 語法說明 popover ---------- */
  const helpMsgs = {
    zh: {
      title: '搜尋語法',
      intro: '輸入文字搜尋全部欄位；可用 欄位:值 限定單一欄位，空白分隔多條件（同時成立）。欄位:* 表示該欄不為空。',
      fields: '可用欄位',
      examples: '範例',
    },
    en: {
      title: 'Search syntax',
      intro:
        'Plain text searches every column. Use field:value to limit one column; separate conditions with spaces (all must match). field:* means the column is not empty.',
      fields: 'Fields',
      examples: 'Examples',
    },
    ja: {
      title: '検索の書き方',
      intro:
        'そのまま入力すると全項目を検索。項目:値 で項目を限定でき、スペース区切りは AND 条件です。項目:* はその項目が空でない行。',
      fields: '使える項目',
      examples: '例',
    },
  }
  const h = $derived(helpMsgs[getLang()] ?? helpMsgs.zh)
  const hasHelp = $derived(!!helpFields?.length)

  let helpOpen = $state(false)
  let helpRoot = $state(null)

  $effect(() => {
    if (!helpOpen) return
    const onPointer = (e) => {
      if (!(e.target instanceof Node) || !helpRoot?.contains(e.target)) helpOpen = false
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.isComposing) helpOpen = false
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  })

  /**
   * 說明列的補充文字：與欄位名同字時不重複顯示
   * （中文介面 `曲名 / song` 後面再寫一次「曲名」是雜訊；`月 / month → YYYY-MM` 才有資訊）
   */
  function extraLabel(f) {
    const primary = String(f.syntax ?? '').split('/')[0].trim().toLowerCase()
    const label = String(f.label ?? '')
    return label && label.toLowerCase() !== primary ? label : ''
  }

  /** 點範例＝直接套用（省得手打全形冒號） */
  function useExample(ex) {
    clearTimeout(timer)
    draft = ex
    helpOpen = false
    flush()
  }
</script>

<!-- 手機獨佔一行（basis-full 逼工具列換行）：字級放大後與月份/動作鈕擠在同列會只剩幾十 px -->
<div class="flex min-w-0 flex-1 basis-full items-center gap-1.5 sm:max-w-sm sm:basis-0">
  <div class="relative min-w-0 flex-1">
    <svg
      class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-berry-fg-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" stroke-linecap="round" />
    </svg>

    <input
      type="search"
      class="w-full rounded-md border border-berry-border bg-berry-bg-3 py-1.5 pl-8 pr-8 text-sm text-berry-fg outline-none transition-colors placeholder:text-berry-fg-3 focus:border-[var(--berry-primary)]"
      placeholder={placeholder || t('common.search')}
      aria-label={t('common.search')}
      value={draft}
      oninput={onInput}
      oncompositionstart={() => (composing = true)}
      oncompositionend={onCompositionEnd}
      onblur={onBlur}
    />

    {#if draft}
      <button
        type="button"
        class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-berry-fg-3 transition-colors hover:text-berry-fg"
        aria-label={t('common.clear')}
        onclick={clear}
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
        </svg>
      </button>
    {/if}
  </div>

  {#if hasHelp}
    <div class="relative shrink-0" bind:this={helpRoot}>
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded-md border border-berry-border bg-berry-bg-3 text-sm leading-none text-berry-fg-3 transition-colors hover:border-[var(--berry-primary)] hover:text-berry-fg"
        aria-label={h.title}
        aria-expanded={helpOpen}
        title={h.title}
        onclick={() => (helpOpen = !helpOpen)}
      >
        ?
      </button>

      {#if helpOpen}
        <div
          class="absolute right-0 top-full z-30 mt-1.5 max-h-[60vh] w-72 max-w-[calc(100vw-2rem)] overflow-auto rounded-lg border border-berry-border bg-berry-bg p-3 shadow-lg"
          role="dialog"
          aria-label={h.title}
        >
          <p class="text-sm text-berry-fg-2">{h.intro}</p>

          <h4 class="mb-1 mt-3 text-sm font-medium text-berry-fg">{h.fields}</h4>
          <ul class="space-y-1">
            {#each helpFields as f (f.syntax)}
              <li class="flex items-baseline gap-2 text-sm">
                <code
                  class="shrink-0 rounded px-1 py-0.5 font-mono text-sm"
                  style="background: var(--berry-subtle-bg); color: var(--berry-text-emphasis)"
                >
                  {f.syntax}
                </code>
                {#if extraLabel(f)}
                  <span class="min-w-0 text-berry-fg-3">{extraLabel(f)}</span>
                {/if}
              </li>
            {/each}
          </ul>

          {#if helpExamples?.length}
            <h4 class="mb-1 mt-3 text-sm font-medium text-berry-fg">{h.examples}</h4>
            <ul class="space-y-1">
              {#each helpExamples as ex (ex)}
                <li>
                  <button
                    type="button"
                    class="w-full rounded border border-berry-border bg-berry-bg-3 px-2 py-1 text-left font-mono text-sm text-berry-fg-2 transition-colors hover:border-[var(--berry-primary)] hover:text-berry-fg"
                    onclick={() => useExample(ex)}
                  >
                    {ex}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
