<script>
  // 下載選單（CSV / JSON）：下載的是「目前篩選結果」，由頁面傳 rows + cols
  import { t } from '../../i18n.svelte.js'
  import { exportRows } from './utils.js'

  let { rows = [], cols = [], basename = 'export', disabled = false } = $props()

  let open = $state(false)
  let rootEl = $state(null)

  function pick(format) {
    open = false
    exportRows(rows, cols, basename, format)
  }

  $effect(() => {
    if (!open) return
    const onPointer = (e) => {
      if (!(e.target instanceof Node) || !rootEl?.contains(e.target)) open = false
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.isComposing) open = false
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  })
</script>

<div class="relative" bind:this={rootEl}>
  <button
    type="button"
    class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-berry-border bg-berry-bg-3 px-3 py-1.5 text-sm leading-none text-berry-fg transition-colors hover:bg-berry-bg-2 disabled:opacity-50"
    aria-expanded={open}
    {disabled}
    title={t('common.download')}
    onclick={() => (open = !open)}
  >
    <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">
      <path d="M12 3v12m0 0l-4-4m4 4l4-4" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M4 19h16" stroke-linecap="round" />
    </svg>
    <span class="hidden sm:inline">{t('common.download')}</span>
  </button>

  {#if open}
    <div class="absolute right-0 top-full z-30 mt-1 min-w-40 rounded-lg border border-berry-border bg-berry-bg py-1 shadow-lg">
      <button
        type="button"
        class="block w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-berry-bg-3"
        onclick={() => pick('csv')}
      >
        {t('common.downloadCsv')}
      </button>
      <button
        type="button"
        class="block w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-berry-bg-3"
        onclick={() => pick('json')}
      >
        {t('common.downloadJson')}
      </button>
    </div>
  {/if}
</div>
