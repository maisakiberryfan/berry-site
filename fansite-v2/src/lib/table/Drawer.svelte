<script>
  // 右側抽屜表單：遮罩點擊 / Esc / 關閉鈕都走 onclose（是否二次確認由頁面決定）
  // ⚠️ Esc 在 IME 組字中（e.isComposing）不關閉——日文輸入取消候選也會送 Esc
  //
  // 焦點（移入／Tab 循環／關閉還原）與背景捲動鎖交給 focusTrap action。
  // focusSeq：頁面把面板內容整批換掉（SetList 的 edit⇄alias⇄reorder）時遞增，
  //   焦點才會跟著移到新內容——只靠 open 的話，模式切換後焦點還留在已消失的舊控制項上。
  import { fade, fly } from 'svelte/transition'
  import { t } from '../../i18n.svelte.js'
  import { focusTrap } from '../focusTrap.svelte.js'

  let {
    open = false,
    title = '',
    subtitle = '',
    width = '460px',
    focusSeq = 0,
    onclose = undefined,
    children,
    footer,
  } = $props()

  // combobox 排除在外：它 focus 就展開下拉，一開 drawer 就蓋一片清單太吵
  const FIRST_FIELD = 'input:not([type=hidden]):not([role=combobox]), textarea, select'

  $effect(() => {
    if (!open) return

    const onKey = (e) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return
      // 上面壓著確認框時 Esc 只關那一層（否則 drawer 會跟著一起關掉）
      if (document.querySelector('[role="alertdialog"]')) return
      onclose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex justify-end">
    <!-- 遮罩：純黑半透明，兩個主題下都是「壓暗背景」語意 -->
    <button
      type="button"
      class="absolute inset-0 cursor-default"
      style="background: rgba(0,0,0,.45)"
      aria-label={t('common.close')}
      transition:fade={{ duration: 140 }}
      onclick={() => onclose?.()}
    ></button>

    <div
      use:focusTrap={() => ({ seq: focusSeq, initial: FIRST_FIELD })}
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      class="relative flex h-full w-full flex-col border-l border-berry-border bg-berry-bg shadow-2xl outline-none"
      style="max-width: min(94vw, {width})"
      transition:fly={{ x: 360, duration: 180, opacity: 1 }}
    >
      <header class="flex items-start gap-3 border-b border-berry-border px-4 py-3">
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-sm font-semibold">{title}</h2>
          {#if subtitle}
            <p class="mt-0.5 truncate text-sm text-berry-fg-3">{subtitle}</p>
          {/if}
        </div>
        <button
          type="button"
          class="-mr-1 rounded-md p-1.5 text-berry-fg-3 transition-colors hover:bg-berry-bg-3 hover:text-berry-fg"
          aria-label={t('common.close')}
          onclick={() => onclose?.()}
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {@render children?.()}
      </div>

      {#if footer}
        <footer class="flex items-center justify-end gap-2 border-t border-berry-border px-4 py-3">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}
