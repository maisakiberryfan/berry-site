<script>
  // 自寫小確認框（不用 window.confirm，才能套主題與 busy 狀態）
  // 焦點（移入最後一顆＝確定鈕／Tab 循環／關閉還原）與背景捲動鎖交給 focusTrap action
  import { fade, scale } from 'svelte/transition'
  import { t } from '../../i18n.svelte.js'
  import { focusTrap } from '../focusTrap.svelte.js'
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

  /** 初始焦點：面板最後一顆鈕＝確定（沿用原行為，Enter 直接確認） */
  const lastButton = (node) => {
    const buttons = node.querySelectorAll('button')
    return buttons[buttons.length - 1] ?? null
  }

  /** 面板本身（tabindex=-1）——busy 期間的焦點停泊處 */
  let panelEl = $state(null)

  $effect(() => {
    if (!open) return
    const onKey = (e) => {
      // keyCode 229＝組字中（部分瀏覽器此時 isComposing 為 false）：Esc 是取消候選字，不是關對話框
      if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229 && !busy) oncancel?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // busy 一轉 true，兩顆鈕都 disabled ⇒ 瀏覽器把焦點丟回 <body>，焦點就此逸出 trap
  // （focusTrap 的 Tab 循環只在焦點還在面板內時有意義，掉到 body 之後 Tab 會跑進背後的頁面）。
  // 把焦點停在面板本身，送出結束後使用者仍在對話框裡。
  $effect(() => {
    if (!open || !busy || !panelEl) return
    const active = document.activeElement
    if (!panelEl.contains(active)) panelEl.focus({ preventScroll: true })
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
      bind:this={panelEl}
      use:focusTrap={() => ({ initial: lastButton })}
      tabindex="-1"
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
