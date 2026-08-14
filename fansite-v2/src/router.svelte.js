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
//
// ⚠️ **路由白名單有四份，新增／改名路由必須四處一起改**（漏一處的症狀各不相同，
//    而且都只在部署後才看得出來）：
//   1. 本檔的 `ROUTES`           —— 站內連結清單的單一真相（給導覽與日後的路由檢查用）
//   2. `src/App.svelte` 的 `PAGES` —— 真正決定渲染哪個頁面元件；漏了就顯示 NotFound
//   3. `template.yaml` 的 `BotBlockerFunction` 內 `spaRoutes`（AWS CloudFront Function）
//      —— 決定「直接輸入網址／重新整理」時要不要 rewrite 成 /index.html；
//      漏了就是站內點得到、但 F5 一按變 S3 的 404（v3 demo 站另有獨立 function
//      `berry-v3-spa-rewrite`，同樣要同步）
//   4. 根 `entry-worker.js` 的 `SPA_ROUTES`（CF 備用站）—— 決定 fallback 回 200 還是
//      404 狀態碼；漏了就是備用站 F5 變 soft-404

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
  '/discography',
]

function normalize(pathname) {
  if (!pathname) return '/'
  // 去掉尾斜線（'/' 本身除外）
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return p || '/'
}

function snapshot() {
  return {
    path: normalize(location.pathname),
    query: new URLSearchParams(location.search),
    hash: location.hash,
  }
}

let current = $state.raw(
  typeof location === 'undefined'
    ? { path: '/', query: new URLSearchParams(), hash: '' }
    : snapshot(),
)

// 「路徑在不在白名單」刻意不由這裡回答：實際判斷是 App.svelte 的 `PAGES[route.path] ?? NotFound`
// （元件表就是那份白名單）。另開一個 route.known／isKnownRoute 等於多養一份會走鐘的副本。
export const route = {
  get path() {
    return current.path
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
