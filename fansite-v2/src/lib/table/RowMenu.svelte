<script>
  // 列動作選單（原站 streamlist 右鍵選單的觸控相容版）
  //
  // 兩個觸發入口共用同一個選單：
  //   桌面 — 整列 contextmenu（座標跟隨滑鼠）
  //   全平台 — 行尾/卡片角落的「⋯」鈕（錨在鈕下方，align='right'）
  // 觸控裝置沒有右鍵，⋯ 鈕才是主要入口；桌面兩者都能用。
  //
  // 用法：
  //   <RowMenu open={!!menu} x={menu?.x} y={menu?.y} align={menu?.align} {items}
  //            onclose={() => (menu = null)} />
  //   items: [{ label, onselect, keepOpen?: boolean } | { divider: true }]
  //
  // 定位用 position:fixed（座標即視窗座標）——因此本元件必須掛在頁面頂層，
  // 不能放進有 transform 的祖先（DataTable 的虛擬滾動容器就有），否則 fixed 會以該祖先為基準。
  import { t } from '../../i18n.svelte.js'

  let {
    open = false,
    /** 視窗座標；align='right' 時 x 是選單的右緣 */
    x = 0,
    y = 0,
    align = 'left',
    items = [],
    onclose = () => {},
    /** 無障礙標籤（選單本身沒有可見標題） */
    label = '',
  } = $props()

  const MARGIN = 8

  let menuEl = $state(null)
  /** 量到尺寸前先隱藏，避免翻轉前的位置閃一下 */
  let pos = $state(null)

  /** 選項按鈕（直接查 DOM，省掉一份會隨 items 變動而失效的 ref 陣列） */
  const itemButtons = () => (menuEl ? [...menuEl.querySelectorAll('[role="menuitem"]')] : [])

  /** 定位：優先放在指定座標，撞到視窗邊緣就往回翻（不是夾住——夾住會蓋住游標/按鈕） */
  $effect(() => {
    if (!open) {
      pos = null
      return
    }
    // 依賴這幾個值：座標一變要重算
    const ax = x
    const ay = y
    const al = align
    const el = menuEl
    if (!el) return

    const { width: w, height: h } = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = al === 'right' ? ax - w : ax
    if (left + w > vw - MARGIN) left = ax - w
    if (left < MARGIN) left = Math.min(MARGIN, vw - w - MARGIN)

    let top = ay
    if (top + h > vh - MARGIN) top = ay - h
    if (top < MARGIN) top = MARGIN

    pos = { left, top }
  })

  // 開啟時把焦點移進選單（鍵盤操作的起點）
  $effect(() => {
    if (!open) return
    queueMicrotask(() => {
      if (open) (itemButtons()[0] ?? menuEl)?.focus?.()
    })
  })

  // 點外面 / Esc / 捲動 / 改變視窗大小都關閉。
  // 捲動要關：選單是 fixed 的，內層表格一捲就會與原本錨定的列脫節。
  $effect(() => {
    if (!open) return
    const onPointer = (e) => {
      if (!(e.target instanceof Element)) return
      // 觸發鈕自己不算「外面」——否則 pointerdown 先關、click 再開，⋯ 鈕就無法切換關閉
      if (e.target.closest('[data-rowmenu-trigger]')) return
      if (menuEl?.contains(e.target)) return
      onclose()
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.isComposing) onclose()
    }
    const close = () => onclose()
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    // capture：內層捲動容器（表格本體）的 scroll 不會冒泡
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  })

  function choose(item) {
    if (!item?.keepOpen) onclose()
    item?.onselect?.()
  }

  /** 上下鍵在選項間移動（分隔線本來就不在清單裡）；Home/End 跳頭尾 */
  function moveFocus(delta) {
    const list = itemButtons()
    if (!list.length) return
    const i = list.indexOf(document.activeElement)
    const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length
    list[next]?.focus()
  }

  function onKeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveFocus(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveFocus(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      itemButtons()[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      const list = itemButtons()
      list[list.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      // 選單不參與 Tab 序：跳出去等同關閉
      onclose()
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={menuEl}
    role="menu"
    tabindex="-1"
    aria-label={label || t('common.actions')}
    class="fixed z-50 min-w-48 max-w-[calc(100vw-1rem)] rounded-lg border border-berry-border bg-berry-bg py-1 shadow-lg outline-none"
    style={pos
      ? `left: ${pos.left}px; top: ${pos.top}px`
      : 'left: 0; top: 0; visibility: hidden'}
    onkeydown={onKeydown}
  >
    <!-- key 用 index：選項標籤會就地變（複製→已複製），拿 label 當 key 會重建節點、焦點跟著掉 -->
    {#each items as item, i (i)}
      {#if item.divider}
        <div class="my-1 h-px bg-berry-border"></div>
      {:else}
        <button
          type="button"
          role="menuitem"
          class="block w-full px-3 py-2 text-left text-base text-berry-fg transition-colors hover:bg-berry-bg-3 focus:bg-berry-bg-3 focus:outline-none"
          onclick={() => choose(item)}
        >
          {item.label}
        </button>
      {/if}
    {/each}
  </div>
{/if}
