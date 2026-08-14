<script module>
  // 每個實例一組 id，供 aria-controls 指向下拉清單
  let uid = 0
  function nextId() {
    return ++uid
  }
</script>

<script>
  // 選歌／選正式名稱用的 typeahead 下拉。
  // ⚠️ IME：Enter 在組字中（e.isComposing / keyCode 229）一律不處理，
  //    否則日文輸入按 Enter 確定候選時會誤選清單第一項（現站 Select2 的老坑）。
  import { t } from '../../i18n.svelte.js'
  import { tokenize, matchesTokens } from './utils.js'

  /**
   * @type {{
   *   options: { id: any, label: string, sub?: string, search: string }[],
   *   value?: any, placeholder?: string, disabled?: boolean, invalid?: boolean,
   *   id?: string, maxItems?: number, allowClear?: boolean,
   *   onselect: (option: any | null) => void,
   * }}
   */
  let {
    options = [],
    value = null,
    placeholder = '',
    disabled = false,
    invalid = false,
    id = undefined,
    maxItems = 80,
    allowClear = true,
    onselect,
  } = $props()

  const listId = `combobox-list-${nextId()}`
  /** 選項的 DOM id：aria-activedescendant 要指到「目前用鍵盤選到的那一項」 */
  const optionId = (i) => `${listId}-opt-${i}`

  let query = $state('')
  let editing = $state(false)
  let open = $state(false)
  let active = $state(0)
  let listEl = $state(null)
  let inputEl = $state(null)

  const selected = $derived(value == null ? null : (options.find((o) => o.id === value) ?? null))
  const display = $derived(editing ? query : (selected?.label ?? ''))

  const filtered = $derived.by(() => {
    const tokens = tokenize(editing ? query : '')
    const out = []
    for (const o of options) {
      if (tokens.length && !matchesTokens(o.search, tokens)) continue
      out.push(o)
      if (out.length >= maxItems) break
    }
    return out
  })

  function openList() {
    if (disabled) return
    editing = true
    query = selected?.label ?? ''
    active = 0
    open = true
  }

  function choose(o) {
    onselect?.(o)
    editing = false
    open = false
    query = ''
  }

  function clear() {
    onselect?.(null)
    editing = false
    open = false
    query = ''
    inputEl?.focus()
  }

  // 組字中間態（ローマ字→かな未確定）不拿去過濾——否則下拉會瞬間 0 筆（SearchBox 同款防護）
  let composing = $state(false)

  function onInput(e) {
    editing = true
    open = true
    if (composing) return
    query = e.currentTarget.value
    active = 0
  }

  function onCompositionStart() {
    composing = true
  }

  function onCompositionEnd(e) {
    composing = false
    query = e.currentTarget.value
    active = 0
  }

  function onKeyDown(e) {
    // ⚠️ IME 組字中的按鍵**全部**交給輸入法：Enter＝確定候選、Escape＝取消候選、
    //    上下鍵＝選候選。統一擋在函式最前面——原本各分支自己守門，漏掉哪一個
    //    （上下鍵就沒守）日文輸入就會誤動作，一道門比四道門可靠（現站 Select2 的老坑）。
    if (e.isComposing || e.keyCode === 229) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) openList()
      else active = Math.min(active + 1, filtered.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (open) {
        active = Math.max(active - 1, 0)
      } else {
        // 關著時按上鍵也開清單（原本只有下鍵會開），並定位末項——與下鍵開在首項對稱
        openList()
        active = Math.max(filtered.length - 1, 0)
      }
    } else if (e.key === 'Enter') {
      if (open && filtered[active]) {
        e.preventDefault()
        choose(filtered[active])
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.stopPropagation() // 只關下拉，不讓 drawer 一起關掉
        open = false
        editing = false
        query = ''
      }
    } else if (e.key === 'Tab') {
      open = false
      editing = false
    }
  }

  // 鍵盤移動時把 active 項捲進視野
  $effect(() => {
    if (!open) return
    active
    queueMicrotask(() => {
      listEl?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    })
  })
</script>

<div class="relative">
  <div class="relative">
    <input
      {id}
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={open && filtered.length ? optionId(Math.min(active, filtered.length - 1)) : undefined}
      aria-autocomplete="list"
      autocomplete="off"
      {disabled}
      {placeholder}
      class="w-full rounded-md border bg-berry-bg-3 py-1.5 pl-2.5 pr-8 text-sm text-berry-fg outline-none transition-colors placeholder:text-berry-fg-3 focus:border-[var(--berry-primary)] disabled:opacity-60"
      style={invalid ? 'border-color: var(--berry-primary)' : 'border-color: var(--berry-border)'}
      bind:this={inputEl}
      value={display}
      oninput={onInput}
      oncompositionstart={onCompositionStart}
      oncompositionend={onCompositionEnd}
      onkeydown={onKeyDown}
      onfocus={openList}
      onblur={() => {
        // 組字中途離開（點別的欄位／關抽屜）時 compositionend 不保證會來；旗標留著
        // 會讓下一次聚焦後的輸入被當成組字中間態而不進 query，下拉就再也篩不動
        composing = false
        open = false
        editing = false
        query = ''
      }}
    />

    {#if selected && allowClear && !disabled}
      <button
        type="button"
        class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-berry-fg-3 transition-colors hover:text-berry-fg"
        aria-label={t('common.clear')}
        onmousedown={(e) => e.preventDefault()}
        onclick={clear}
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
        </svg>
      </button>
    {:else}
      <svg
        class="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-berry-fg-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    {/if}
  </div>

  {#if selected?.sub && !open}
    <p class="mt-1 truncate text-sm text-berry-fg-3">{selected.sub}</p>
  {/if}

  {#if open}
    <ul
      id={listId}
      bind:this={listEl}
      role="listbox"
      class="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-berry-border bg-berry-bg py-1 shadow-lg"
    >
      {#if filtered.length === 0}
        <li class="px-3 py-2 text-sm text-berry-fg-3">{t('common.noResults')}</li>
      {:else}
        {#each filtered as o, i (o.id)}
          <li>
            <button
              type="button"
              role="option"
              id={optionId(i)}
              aria-selected={o.id === value}
              data-active={i === active}
              class="block w-full px-3 py-1.5 text-left text-sm transition-colors {i === active
                ? 'bg-berry-bg-2'
                : 'hover:bg-berry-bg-3'}"
              onmousedown={(e) => e.preventDefault()}
              onclick={() => choose(o)}
              onmouseenter={() => (active = i)}
            >
              <span class="block truncate">{o.label}</span>
              {#if o.sub}
                <span class="block truncate text-sm text-berry-fg-3">{o.sub}</span>
              {/if}
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  {/if}
</div>
