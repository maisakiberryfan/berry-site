<script>
  // 全螢幕圖片 Lightbox：自寫、無外部依賴（不裝 Fancybox）。
  // 左右鍵/按鈕切換、Esc 關閉、顯示 n/total。背景刻意用純黑遮罩——
  // 這是圖片檢視器的通用視覺慣例（滿版沉浸感），不是「亮/暗主題前提色」，
  // 罩層上只有白色圖示按鈕，兩種主題下都自洽，不受 app.css tokens 支配。
  import { untrack } from 'svelte'

  /** @type {{ images: Array<{src: string, alt?: string}>, startIndex?: number, onClose: () => void }} */
  let { images, startIndex = 0, onClose } = $props()

  // 只取「開啟當下」的初始值 —— 元件因 {#if lightbox} 換圖而整個重建，
  // 之後左右鍵切換走自己的 index 狀態，不隨 props 變動而跟著跳動
  let index = $state(untrack(() => Math.min(Math.max(startIndex, 0), Math.max(images.length - 1, 0))))

  const total = $derived(images.length)
  const current = $derived(images[index])

  function next() {
    index = (index + 1) % total
  }
  function prev() {
    index = (index - 1 + total) % total
  }

  function onKeydown(e) {
    if (e.key === 'Escape') onClose?.()
    else if (e.key === 'ArrowRight') next()
    else if (e.key === 'ArrowLeft') prev()
  }

  function onBackdropClick(e) {
    if (e.target === e.currentTarget) onClose?.()
  }

  $effect(() => {
    document.addEventListener('keydown', onKeydown)
    const prevOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeydown)
      document.documentElement.style.overflow = prevOverflow
    }
  })
</script>

<div
  class="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm"
  role="dialog"
  aria-modal="true"
  aria-label="image viewer"
  tabindex="-1"
  onclick={onBackdropClick}
  onkeydown={onKeydown}
>
  <div class="flex items-center justify-between px-4 py-3 text-sm text-white/85">
    <span class="font-mono">{index + 1} / {total}</span>
    <button
      type="button"
      class="rounded-md p-1.5 transition-colors hover:bg-white/10"
      aria-label="close"
      onclick={() => onClose?.()}
    >
      <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  </div>

  <div class="relative flex flex-1 items-center justify-center overflow-hidden px-4 pb-4 sm:px-14">
    {#if total > 1}
      <button
        type="button"
        class="absolute left-2 top-1/2 -translate-y-1/2 rounded-full p-2 text-white/85 transition-colors hover:bg-white/10 sm:left-4"
        aria-label="previous"
        onclick={prev}
      >
        <svg viewBox="0 0 24 24" class="size-7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
    {/if}

    {#if current}
      <img src={current.src} alt={current.alt ?? ''} class="max-h-full max-w-full rounded-md object-contain" />
    {/if}

    {#if total > 1}
      <button
        type="button"
        class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-2 text-white/85 transition-colors hover:bg-white/10 sm:right-4"
        aria-label="next"
        onclick={next}
      >
        <svg viewBox="0 0 24 24" class="size-7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 5l7 7-7 7" />
        </svg>
      </button>
    {/if}
  </div>
</div>
