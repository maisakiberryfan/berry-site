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

  function onInput(e) {
    editing = true
    query = e.currentTarget.value
    active = 0
    open = true
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) openList()
      else active = Math.min(active + 1, filtered.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      active = Math.max(active - 1, 0)
    } else if (e.key === 'Enter') {
      if (e.isComposing || e.keyCode === 229) return // 組字確定：交給 IME
      if (open && filtered[active]) {
        e.preventDefault()
        choose(filtered[active])
      }
    } else if (e.key === 'Escape') {
      if (e.isComposing || e.keyCode === 229) return
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
      aria-autocomplete="list"
      autocomplete="off"
      {disabled}
      {placeholder}
      class="w-full rounded-md border bg-berry-bg-3 py-1.5 pl-2.5 pr-8 text-sm text-berry-fg outline-none transition-colors placeholder:text-berry-fg-3 focus:border-[var(--berry-primary)] disabled:opacity-60"
      style={invalid ? 'border-color: var(--berry-primary)' : 'border-color: var(--berry-border)'}
      bind:this={inputEl}
      value={display}
      oninput={onInput}
      onkeydown={onKeyDown}
      onfocus={openList}
      onblur={() => {
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
