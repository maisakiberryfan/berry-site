<script>
  // 自由字串 tag 輸入（streamlist categories 用）：Enter / 逗號新增、Backspace 退位刪除、
  // 下方列出既有 tag 建議。⚠️ Enter 在 IME 組字中不處理。
  import { t } from '../../i18n.svelte.js'

  /** @type {{ tags: string[], suggestions?: string[], placeholder?: string, invalid?: boolean, max?: number, onchange: (next: string[]) => void }} */
  let { tags = [], suggestions = [], placeholder = '', invalid = false, max = 20, onchange } = $props()

  let draft = $state('')

  const hints = $derived(suggestions.filter((s) => !tags.includes(s)).slice(0, 10))

  function add(raw) {
    const v = String(raw ?? '').trim()
    if (!v || tags.includes(v) || tags.length >= max) {
      draft = ''
      return
    }
    onchange([...tags, v])
    draft = ''
  }

  function remove(tag) {
    onchange(tags.filter((t2) => t2 !== tag))
  }

  /**
   * 失焦：**只有 draft 完全命中既有建議時才自動加入**。
   *
   * 舊行為是無條件 `add(draft)`，兩個實害：
   *   · 打「歌」再點下方建議鈕 → 先觸發 blur 把「歌」加成一個新分類，再加建議項（兩個 tag）
   *   · 打到一半直接按「儲存」→ 半成品字串被當成分類寫進 DB
   * 分類是全站共用的自由字串集合，造出來的錯別字沒有人會回頭清（v2 的 `other` 就是這樣來的）。
   * 要新增全新分類仍可按 Enter／逗號——那是明確的意思表示，blur 不是。
   * 不命中時 draft 原樣留著（清掉會讓使用者以為輸入被吃了）。
   */
  function onBlur() {
    const v = draft.trim()
    if (!v) {
      draft = ''
      return
    }
    if (suggestions.includes(v)) add(v)
  }

  function onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(draft)
    } else if (e.key === 'Backspace' && draft === '' && tags.length) {
      e.preventDefault()
      remove(tags[tags.length - 1])
    }
  }
</script>

<div>
  <div
    class="flex flex-wrap items-center gap-1.5 rounded-md border bg-berry-bg-3 px-2 py-1.5"
    style={invalid ? 'border-color: var(--berry-primary)' : 'border-color: var(--berry-border)'}
  >
    {#each tags as tag (tag)}
      <span
        class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm"
        style="background: var(--berry-subtle-bg); border-color: var(--berry-subtle-border); color: var(--berry-text-emphasis)"
      >
        {tag}
        <button
          type="button"
          class="opacity-60 transition-opacity hover:opacity-100"
          aria-label="{t('common.delete')} {tag}"
          onclick={() => remove(tag)}
        >
          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
      </span>
    {/each}

    <input
      type="text"
      class="min-w-24 flex-1 bg-transparent py-0.5 text-sm text-berry-fg outline-none placeholder:text-berry-fg-3"
      {placeholder}
      bind:value={draft}
      onkeydown={onKeyDown}
      onblur={onBlur}
    />
  </div>

  {#if hints.length}
    <!-- 建議鈕：onmousedown preventDefault 保住輸入框焦點（同 Combobox 的選項列）——
         否則按下的瞬間先 blur、再 click，兩件事的順序讓 draft 也被處理一輪 -->
    <div class="mt-1.5 flex flex-wrap gap-1">
      {#each hints as s (s)}
        <button
          type="button"
          class="rounded-full border border-berry-border bg-berry-bg-3 px-2.5 py-1 text-sm text-berry-fg-2 transition-colors hover:bg-berry-bg-2"
          onmousedown={(e) => e.preventDefault()}
          onclick={() => add(s)}
        >
          + {s}
        </button>
      {/each}
    </div>
  {/if}
</div>
