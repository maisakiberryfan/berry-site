<script>
  // 篩選 chip 列（單選或多選 OR 語意）。第一顆恆為「全部」。
  import { t } from '../../i18n.svelte.js'

  /** @type {{ options: {value: string, label: string, count?: number}[], selected: string[], multiple?: boolean, onchange: (next: string[]) => void, max?: number }} */
  let { options = [], selected = [], multiple = true, onchange, max = 14 } = $props()

  const shown = $derived(options.slice(0, max))

  function toggle(value) {
    if (!multiple) {
      onchange(selected[0] === value ? [] : [value])
      return
    }
    onchange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  const chipBase =
    'rounded-full border px-3 py-1.5 text-sm leading-none transition-colors whitespace-nowrap'
</script>

<div class="flex flex-wrap items-center gap-1.5">
  <button
    type="button"
    class="{chipBase} {selected.length === 0
      ? 'border-transparent text-berry-fg'
      : 'border-berry-border bg-berry-bg-3 text-berry-fg-2 hover:bg-berry-bg-2'}"
    style={selected.length === 0
      ? 'background: var(--berry-subtle-bg); border-color: var(--berry-subtle-border); color: var(--berry-text-emphasis)'
      : ''}
    onclick={() => onchange([])}
  >
    {t('common.all')}
  </button>

  {#each shown as opt (opt.value)}
    {@const on = selected.includes(opt.value)}
    <button
      type="button"
      class="{chipBase} {on
        ? 'border-transparent'
        : 'border-berry-border bg-berry-bg-3 text-berry-fg-2 hover:bg-berry-bg-2'}"
      style={on
        ? 'background: var(--berry-subtle-bg); border-color: var(--berry-subtle-border); color: var(--berry-text-emphasis)'
        : ''}
      aria-pressed={on}
      onclick={() => toggle(opt.value)}
    >
      {opt.label}{#if opt.count != null}<span class="ml-1 opacity-60">{opt.count}</span>{/if}
    </button>
  {/each}
</div>
