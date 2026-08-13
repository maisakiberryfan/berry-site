// 極簡 SPA router（history API，無依賴）
//
// 用法：
//   import { route, navigate } from './router.svelte.js'
//   route.path   // '/setlist'（reactive）
//   route.query  // URLSearchParams（reactive）
//   route.hash   // '#20240101'（reactive）
//   navigate('/songlist')
//
// 站內 <a href="/xxx"> 的點擊由本模組全域攔截，元件不必自己處理。
// 部署端的 SPA rewrite 白名單見 template.yaml 的 BotBlockerFunction —— 新增路由要同步更新。

export const ROUTES = [
  '/',
  '/songlist',
  '/streamlist',
  '/setlist',
  '/aliases',
  '/analytics',
  '/profile',
  '/history',
  '/clothes',
]

function normalize(pathname) {
  if (!pathname) return '/'
  // 去掉尾斜線（'/' 本身除外）
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return p || '/'
}

export function isKnownRoute(path) {
  return ROUTES.includes(normalize(path))
}

function snapshot() {
  const path = normalize(location.pathname)
  return {
    path,
    known: ROUTES.includes(path),
    query: new URLSearchParams(location.search),
    hash: location.hash,
  }
}

let current = $state.raw(
  typeof location === 'undefined'
    ? { path: '/', known: true, query: new URLSearchParams(), hash: '' }
    : snapshot(),
)

export const route = {
  get path() {
    return current.path
  },
  /** 路徑是否在白名單內（否則頁面層顯示 NotFound） */
  get known() {
    return current.known
  },
  get query() {
    return current.query
  },
  get hash() {
    return current.hash
  },
}

function update() {
  current = snapshot()
}

/** 程式化導航。同一路徑不 push 新的歷史紀錄。 */
export function navigate(to, { replace = false, scroll = true } = {}) {
  const url = new URL(to, location.href)
  if (url.origin !== location.origin) {
    location.href = url.href
    return
  }
  const same = url.pathname === location.pathname && url.search === location.search && url.hash === location.hash
  if (!same) {
    if (replace) history.replaceState({}, '', url)
    else history.pushState({}, '', url)
    update()
  }
  if (scroll && !url.hash) window.scrollTo({ top: 0, behavior: 'instant' })
}

/** 是否為「本站內部、應由 router 接手」的連結 */
function isInternalLink(anchor) {
  if (!anchor) return false
  if (anchor.target && anchor.target !== '_self') return false
  if (anchor.hasAttribute('download')) return false
  if (anchor.dataset.native !== undefined) return false // opt-out：<a data-native>
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false
  const url = new URL(anchor.href, location.href)
  return url.origin === location.origin
}

let started = false

/** main.js / App.svelte 啟動一次即可（重複呼叫無害） */
export function startRouter() {
  if (started || typeof window === 'undefined') return
  started = true

  window.addEventListener('popstate', update)

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const anchor = e.target instanceof Element ? e.target.closest('a') : null
    if (!isInternalLink(anchor)) return
    e.preventDefault()
    navigate(anchor.href)
  })
}
