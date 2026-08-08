<script>
  // 自寫小確認框（不用 window.confirm，才能套主題與 busy 狀態）
  import { fade, scale } from 'svelte/transition'
  import { t } from '../../i18n.svelte.js'
  import Button from './Button.svelte'

  let {
    open = false,
    title = '',
    message = '',
    confirmLabel = '',
    cancelLabel = '',
    busy = false,
    error = '',
    onconfirm = undefined,
    oncancel = undefined,
  } = $props()

  let boxEl = $state(null)

  $effect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.isComposing && !busy) oncancel?.()
    }
    document.addEventListener('keydown', onKey)
    const el = boxEl
    queueMicrotask(() => {
      const buttons = el?.querySelectorAll('button')
      buttons?.[buttons.length - 1]?.focus({ preventScroll: true }) // 最後一顆＝確定
    })
    return () => document.removeEventListener('keydown', onKey)
  })
</script>

{#if open}
  <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
    <button
      type="button"
      class="absolute inset-0 cursor-default"
      style="background: rgba(0,0,0,.45)"
      aria-label={t('common.cancel')}
      transition:fade={{ duration: 120 }}
      onclick={() => !busy && oncancel?.()}
    ></button>

    <div
      bind:this={boxEl}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      class="relative w-full max-w-sm rounded-lg border border-berry-border bg-berry-bg p-4 shadow-2xl"
      transition:scale={{ duration: 140, start: 0.97 }}
    >
      <h2 class="text-sm font-semibold">{title || t('common.confirm')}</h2>
      {#if message}
        <p class="mt-2 text-sm text-berry-fg-2">{message}</p>
      {/if}
      {#if error}
        <p class="mt-2 text-sm" style="color: var(--berry-primary)">{error}</p>
      {/if}

      <div class="mt-4 flex justify-end gap-2">
        <Button size="md" disabled={busy} onclick={() => oncancel?.()}>
          {cancelLabel || t('common.cancel')}
        </Button>
        <Button size="md" variant="primary" {busy} onclick={() => onconfirm?.()}>
          {confirmLabel || t('common.confirm')}
        </Button>
      </div>
    </div>
  </div>
{/if}
