<script>
  // 資料層狀態列（placeholder 階段用來證明三層瀑布可用；正式頁面可沿用或替換）
  import { t } from '../i18n.svelte.js'

  /** @type {{ store: { rows?: any[], loading: boolean, synced: boolean, error: any }, label?: string }} */
  let { store, label = '' } = $props()
</script>

<div class="flex flex-wrap items-center gap-3 text-sm">
  <span class="rounded-md border border-berry-border bg-berry-bg-3 px-2.5 py-1 font-mono">
    {label}
    {store.rows ? t('common.rowCount', { n: store.rows.length }) : ''}
  </span>

  {#if store.loading}
    <span class="text-berry-fg-3">{t('common.loadingData')}</span>
  {:else if store.error}
    <span style="color: var(--berry-primary)">
      {t('common.error')} — {store.error.code ?? ''} {store.error.message ?? ''}
    </span>
  {:else if store.synced}
    <span class="text-berry-fg-3">{t('common.synced')}</span>
  {:else}
    <span class="text-berry-fg-3">{t('common.syncing')}</span>
  {/if}
</div>
