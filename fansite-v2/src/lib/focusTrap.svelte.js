// 對話框／抽屜的焦點管理（Svelte 5 action）
//
//   <div use:focusTrap={() => ({ seq, initial: 'input, textarea' })}> … </div>
//
// 只做三件事：
//   1. 掛載時把焦點移進面板（[autofocus] → initial → 第一個可聚焦元素 → 面板本身）
//   2. Tab / Shift+Tab 在面板內循環（焦點跑不到背後的頁面）
//   3. 卸載時把焦點還給「開啟前那個元素」（通常是開啟它的那顆鈕）
// Esc／遮罩點擊等關閉行為一律不碰——那是各對話框自己的事，刻意不動。
//
// 參數可傳物件，或傳「回傳物件的函式」（seq 要能變動就必須用函式形式，才讀得到最新值）：
//   seq         值一變就重新把焦點移進面板。面板內容整批換掉時用
//               （SetList 的 drawer edit⇄alias⇄reorder：DOM 換人但元素沒卸載，
//                只靠掛載時聚焦會停在已被移除的舊控制項上）
//   initial     初始焦點：CSS 選擇器字串或 (node) => Element|null；找不到就退回第一個可聚焦元素
//   lockScroll  預設 true。開啟期間鎖住 body 捲動；多層對話框以計數器疊加，最後一層關掉才還原
//   active      預設 true，**掛載當下決定**（五個使用處都是 {#if open} 控制元素存在與否，
//               用不到動態切換；要條件啟用請用 {#if} 包住節點）
//
// ⚠️ 元素本身要能吃焦點（面板內沒有任何可聚焦元素時會退回聚焦節點自身），
//    請給它 tabindex="-1"。
import { untrack } from 'svelte'

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex^="-"])',
].join(',')

/** 只算「畫得出來」的元素：display:none／collapse 的控制項不進 Tab 序 */
function isVisible(el) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
}

function focusables(node) {
  return Array.from(node.querySelectorAll(FOCUSABLE)).filter(
    (el) => isVisible(el) && !el.closest('[inert]'),
  )
}

/* ---------- body 捲動鎖（多層對話框共用同一個計數器） ---------- */
let lockCount = 0
let lockedFrom = ''

function lockScrollOn() {
  if (lockCount === 0) {
    lockedFrom = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  lockCount++
}

function lockScrollOff() {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) document.body.style.overflow = lockedFrom
}

/**
 * 上面還壓著另一層對話框時不攔 Tab —— 讓最上層那個自己管（沒管的就維持原本可 Tab 到的行為，
 * 例如 Clothes 詳細面板上的 Lightbox）。以 DOM 順序判斷「上層」：本站的對話框一律掛在
 * 頁面尾端、後出現＝疊在上面（z-index 亦同序）。
 */
function hasDialogAbove(node) {
  const dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"]')
  for (const d of dialogs) {
    if (d === node || node.contains(d)) continue
    if (node.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) return true
  }
  return false
}

function resolveInitial(node, initial) {
  try {
    if (typeof initial === 'function') return initial(node)
    if (typeof initial === 'string') return node.querySelector(initial)
  } catch {
    // 壞選擇器不該讓整個對話框開不起來
  }
  return null
}

function focusInto(node, initial) {
  const list = focusables(node)
  const auto = node.querySelector('[autofocus]')
  const wanted = resolveInitial(node, initial)
  const target =
    (auto && isVisible(auto) ? auto : null) ??
    (wanted && isVisible(wanted) ? wanted : null) ??
    list[0] ??
    node
  target?.focus?.({ preventScroll: true })
}

/**
 * @type {import('svelte/action').Action<HTMLElement, any>}
 */
export function focusTrap(node, params) {
  const read = () => {
    const v = typeof params === 'function' ? params() : params
    return v ?? {}
  }

  // 掛載／卸載：記住開啟前的焦點、掛 Tab 循環、鎖捲動、關閉時還原焦點。
  // 這一輪刻意不追蹤任何 reactive 值（untrack）——seq 變動只該重新聚焦，
  // 不該把「開啟前的焦點」重抓成面板內的元素（那樣關閉時就還原不回去了）。
  $effect(() => {
    const opts = untrack(read)
    if (opts.active === false) return

    const lock = opts.lockScroll !== false
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null

    function onKeydown(e) {
      // IME 組字中的 Tab 是候選字操作，不攔
      if (e.key !== 'Tab' || e.isComposing || e.keyCode === 229) return
      if (hasDialogAbove(node)) return
      const list = focusables(node)
      if (list.length === 0) {
        e.preventDefault()
        node.focus?.({ preventScroll: true })
        return
      }
      const cur = document.activeElement
      const edge = e.shiftKey ? list[0] : list[list.length - 1]
      if (cur === edge || !node.contains(cur)) {
        e.preventDefault()
        ;(e.shiftKey ? list[list.length - 1] : list[0]).focus({ preventScroll: true })
      }
    }

    node.addEventListener('keydown', onKeydown)
    if (lock) lockScrollOn()

    return () => {
      node.removeEventListener('keydown', onKeydown)
      if (lock) lockScrollOff()
      // 元素已從文件移除（換頁等）就不還原，免得把焦點丟到 <body> 以外的怪地方
      if (restore?.isConnected) restore.focus({ preventScroll: true })
    }
  })

  // 焦點移入：掛載後一次，之後每當 seq 變動再一次（內容剛換過，等 DOM 落地再找元素）
  $effect(() => {
    const { seq, initial, active } = read()
    void seq
    if (active === false) return
    queueMicrotask(() => {
      if (node.isConnected) focusInto(node, initial)
    })
  })
}
