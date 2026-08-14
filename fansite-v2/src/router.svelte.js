// 極簡 SPA router（history API，無依賴）
//
// 用法：
//   import { route, navigate } from './router.svelte.js'
//   route.path    // '/discography/rebirthr'（reactive，含動態段的完整路徑）
//   route.pattern // '/discography/:id'——比對到的路由樣式（未知路徑＝原路徑）
//   route.page    // '/discography'——頁面身分（樣式去掉動態段；換頁重建的 key 用這個）
//   route.id      // 'rebirthr'——動態段的值（已 decodeURIComponent；無動態段＝''）
//   route.query   // URLSearchParams（reactive）
//   route.hash    // '#20240101'（reactive）
//   navigate('/songlist')
//
// 站內 <a href="/xxx"> 的點擊由本模組全域攔截，元件不必自己處理。
//
// ⚠️ **路由白名單有四份，新增／改名路由必須四處一起改**（漏一處的症狀各不相同，
//    而且都只在部署後才看得出來）：
//   1. 本檔的 `ROUTES`           —— 站內連結清單的單一真相（給導覽與日後的路由檢查用）
//   2. `src/App.svelte` 的 `PAGES` —— 真正決定渲染哪個頁面元件；漏了就顯示 NotFound
//   3. `template.yaml` 的 `BotBlockerFunction` 內 `spaRoutes`／`spaPrefixes`
//      （AWS CloudFront Function）—— 決定「直接輸入網址／重新整理」時要不要 rewrite
//      成 /index.html；漏了就是站內點得到、但 F5 一按變 S3 的 404（v3 demo 站另有
//      獨立 function `berry-v3-spa-rewrite`，同樣要同步）
//   4. 根 `entry-worker.js` 的 `SPA_ROUTES`／`SPA_PREFIXES`（CF 備用站）—— 決定
//      fallback 回 200 還是 404 狀態碼；漏了就是備用站 F5 變 soft-404
//
// 帶 `/:id` 的項目＝動態段路由（詳細頁 path 化，2026-08-14 由 hash 改制）：
// `/clothes/20260611`、`/discography/rebirthr` 這種深連結各自對應一個頁面元件，
// **id 的合法性不由 router 判斷**（同下方 route.pattern 的註解）——認不得的 id
// 由頁面自己決定怎麼辦（現況：當作沒開面板，顯示總覽）。

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
  '/clothes/:id',
  '/discography',
  '/discography/:id',
]

/** 動態段後綴——目前只有一種形狀（單層 `/:id`），比對邏輯照此假設寫 */
const DYNAMIC_SUFFIX = '/:id'

/** 由 ROUTES 推導的動態段前綴集合（`/clothes/:id` → `/clothes`），避免另養一份清單 */
const DYNAMIC_PREFIXES = new Set(
  ROUTES.filter((r) => r.endsWith(DYNAMIC_SUFFIX)).map((r) => r.slice(0, -DYNAMIC_SUFFIX.length)),
)

/** 靜態路由集合（不含動態段者） */
const STATIC_ROUTES = new Set(ROUTES.filter((r) => !r.endsWith(DYNAMIC_SUFFIX)))

function normalize(pathname) {
  if (!pathname) return '/'
  // 去掉尾斜線（'/' 本身除外）
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  return p || '/'
}

/**
 * 路徑 → { pattern, id }。
 * 靜態路由原樣回傳；`/clothes/xxx` 這種單層動態段回 `{ pattern:'/clothes/:id', id:'xxx' }`；
 * 都不符合就回 `{ pattern: 路徑原值, id:'' }`（＝ App.svelte 查不到元件 ⇒ NotFound）。
 * 多層（`/clothes/a/b`）刻意不匹配：站上沒有這種結構，讓它落到 NotFound 比默默吃掉好。
 */
export function matchRoute(path) {
  if (STATIC_ROUTES.has(path)) return { pattern: path, id: '' }
  const cut = path.indexOf('/', 1)
  if (cut > 0) {
    const prefix = path.slice(0, cut)
    const rest = path.slice(cut + 1)
    if (rest && !rest.includes('/') && DYNAMIC_PREFIXES.has(prefix)) {
      let id = rest
      try {
        id = decodeURIComponent(rest)
      } catch {
        // 壞的 % 序列：用原字串（頁面比不到就當作未知 id）
      }
      return { pattern: prefix + DYNAMIC_SUFFIX, id }
    }
  }
  return { pattern: path, id: '' }
}

/** 樣式 → 頁面身分（`/clothes/:id` → `/clothes`）：同一頁換 id 不算換頁 */
function pageOf(pattern) {
  return pattern.endsWith(DYNAMIC_SUFFIX) ? pattern.slice(0, -DYNAMIC_SUFFIX.length) : pattern
}

function snapshot() {
  const path = normalize(location.pathname)
  const { pattern, id } = matchRoute(path)
  return {
    path,
    pattern,
    page: pageOf(pattern),
    id,
    query: new URLSearchParams(location.search),
    hash: location.hash,
  }
}

let current = $state.raw(
  typeof location === 'undefined'
    ? { path: '/', pattern: '/', page: '/', id: '', query: new URLSearchParams(), hash: '' }
    : snapshot(),
)

// 「路徑在不在白名單」刻意不由這裡回答：實際判斷是 App.svelte 的 `PAGES[route.pattern] ?? NotFound`
// （元件表就是那份白名單）。另開一個 route.known／isKnownRoute 等於多養一份會走鐘的副本。
// 動態段同理：matchRoute 只答「形狀對不對」，id 存不存在由頁面用自己的資料模組判斷。
export const route = {
  get path() {
    return current.path
  },
  get pattern() {
    return current.pattern
  },
  get page() {
    return current.page
  },
  get id() {
    return current.id
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
