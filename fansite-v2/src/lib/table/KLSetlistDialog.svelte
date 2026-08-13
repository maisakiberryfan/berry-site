<script>
  // KL 格式歌單檢視框（唯讀）——站主核對留言／貼社群用
  //
  // 只負責顯示與複製：文字由頁面端格式化後傳進來（載入中／空／錯誤三態也由頁面決定）。
  // 版面對齊 ConfirmDialog（同一層遮罩語意），內容區走等寬字體並可捲動。
  import { fade, scale } from 'svelte/transition'
  import { t } from '../../i18n.svelte.js'
  import Button from './Button.svelte'

  let {
    open = false,
    title = '',
    subtitle = '',
    /** 已格式化的純文字（空字串＝無資料，顯示 emptyMessage） */
    text = '',
    loading = false,
    error = '',
    emptyMessage = '',
    copyLabel = '',
    copyFailedLabel = '',
    onclose = undefined,
  } = $props()

  let boxEl = $state(null)
  let copied = $state(false)
  let copyFailed = $state(false)
  let copyTimer

  // 每次開啟都把複製狀態歸零（上次的「已複製」不殘留）
  $effect(() => {
    if (open) return
    clearTimeout(copyTimer)
    copied = false
    copyFailed = false
  })

  $effect(() => () => clearTimeout(copyTimer))

  $effect(() => {
    if (!open) return
    const onKey = (e) => {
      // IME 組字中的 Esc 是取消候選，不關視窗
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return
      onclose?.()
    }
    document.addEventListener('keydown', onKey)
    const el = boxEl
    queueMicrotask(() => el?.focus?.({ preventScroll: true }))
    return () => document.removeEventListener('keydown', onKey)
  })

  async function copyAll() {
    if (!text) return
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      // 非安全來源／權限被擋時的退路
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        ta.remove()
      } catch {
        ok = false
      }
    }
    copied = ok
    copyFailed = !ok
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied = false
      copyFailed = false
    }, 1600)
  }
</script>

{#if open}
  <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
    <button
      type="button"
      class="absolute inset-0 cursor-default"
      style="background: rgba(0,0,0,.45)"
      aria-label={t('common.close')}
      transition:fade={{ duration: 120 }}
      onclick={() => onclose?.()}
    ></button>

    <div
      bind:this={boxEl}
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      class="relative flex max-h-[86vh] w-full max-w-2xl flex-col rounded-lg border border-berry-border bg-berry-bg shadow-2xl outline-none"
      transition:scale={{ duration: 140, start: 0.97 }}
    >
      <header class="flex items-start gap-3 border-b border-berry-border px-4 py-3">
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-sm font-semibold">{title}</h2>
          {#if subtitle}
            <p class="mt-0.5 truncate text-sm text-berry-fg-3" title={subtitle}>{subtitle}</p>
          {/if}
        </div>
        <button
          type="button"
          class="-mr-1 rounded-md p-1.5 text-berry-fg-3 transition-colors hover:bg-berry-bg-3 hover:text-berry-fg"
          aria-label={t('common.close')}
          onclick={() => onclose?.()}
        >
          <svg
            class="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {#if loading}
          <p class="py-6 text-center text-sm text-berry-fg-3">{t('common.loading')}</p>
        {:else if error}
          <p class="py-6 text-center text-sm" style="color: var(--berry-primary)">{error}</p>
        {:else if !text}
          <p class="py-6 text-center text-sm text-berry-fg-3">
            {emptyMessage || t('common.noData')}
          </p>
        {:else}
          <!-- 純文字唯讀顯示：等寬對齊時間戳，長行折回不橫捲 -->
          <pre
            class="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-berry-border bg-berry-bg-3 px-3 py-2 font-mono text-sm leading-relaxed text-berry-fg">{text}</pre>
        {/if}
      </div>

      <footer class="flex items-center justify-end gap-2 border-t border-berry-border px-4 py-3">
        <Button onclick={() => onclose?.()}>{t('common.close')}</Button>
        <Button variant="primary" disabled={!text || loading} onclick={copyAll}>
          {copied
            ? t('common.copied')
            : copyFailed
              ? copyFailedLabel || t('common.error')
              : copyLabel || t('common.copy')}
        </Button>
      </footer>
    </div>
  </div>
{/if}
