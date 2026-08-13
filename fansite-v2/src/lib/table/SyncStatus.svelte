<script>
  // 頁首右側：同步狀態小圓點 ＋ 重新載入鈕
  import { t } from '../../i18n.svelte.js'

  /** @type {{ store: { loading: boolean, synced: boolean, error: any, reload: () => any } }} */
  let { store } = $props()

  let reloading = $state(false)

  async function reload() {
    if (reloading) return
    reloading = true
    try {
      await store.reload()
    } finally {
      reloading = false
    }
  }

  const state = $derived(
    store.loading || reloading ? 'busy' : store.error ? 'error' : store.synced ? 'ok' : 'busy',
  )
  const label = $derived(
    state === 'busy'
      ? t('common.syncing')
      : state === 'error'
        ? t('common.offline')
        : t('common.synced'),
  )
  const dot = $derived(
    state === 'ok'
      ? 'background: var(--berry-green)'
      : state === 'error'
        ? 'background: var(--berry-primary)'
        : 'background: var(--berry-fg-3)',
  )
</script>

<div class="flex items-center gap-2 text-sm text-berry-fg-3">
  <span class="inline-flex items-center gap-1.5" title={label}>
    <span class="inline-block size-1.5 rounded-full" style={dot}></span>
    <span class="hidden sm:inline">{label}</span>
  </span>

  <button
    type="button"
    class="rounded-md p-1.5 text-berry-fg-3 transition-colors hover:bg-berry-bg-3 hover:text-berry-fg disabled:opacity-40"
    title={t('common.reload')}
    aria-label={t('common.reload')}
    disabled={reloading}
    onclick={reload}
  >
    <svg
      class="size-4 {reloading ? 'animate-spin' : ''}"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 1 1-2.3-5.6" stroke-linecap="round" />
      <path d="M20 4v4h-4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
</div>
