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
      onblur={() => add(draft)}
    />
  </div>

  {#if hints.length}
    <div class="mt-1.5 flex flex-wrap gap-1">
      {#each hints as s (s)}
        <button
          type="button"
          class="rounded-full border border-berry-border bg-berry-bg-3 px-2.5 py-1 text-sm text-berry-fg-2 transition-colors hover:bg-berry-bg-2"
          onclick={() => add(s)}
        >
          + {s}
        </button>
      {/each}
    </div>
  {/if}
</div>
