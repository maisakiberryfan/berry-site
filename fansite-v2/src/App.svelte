<script>
  import Navbar from './lib/Navbar.svelte'
  import { siteLinks } from './nav.js'
  import { icons } from './lib/icons.js'
  import { route, startRouter } from './router.svelte.js'

  import Home from './pages/Home.svelte'
  import SongList from './pages/SongList.svelte'
  import StreamList from './pages/StreamList.svelte'
  import SetList from './pages/SetList.svelte'
  import Aliases from './pages/Aliases.svelte'
  import Analytics from './pages/Analytics.svelte'
  import Profile from './pages/Profile.svelte'
  import History from './pages/History.svelte'
  import Clothes from './pages/Clothes.svelte'
  import Discography from './pages/Discography.svelte'
  import NotFound from './pages/NotFound.svelte'

  startRouter()

  // 路由樣式 → 頁面元件（白名單四份之一，見 router.svelte.js 檔頭）。
  // `/:id` 是動態段路由：同一個元件，由 route.id 決定要開哪一項詳細面板
  // （id 認不得時頁面顯示總覽——合法性由頁面的資料模組判斷，不在 router）。
  const PAGES = {
    '/': Home,
    '/songlist': SongList,
    '/streamlist': StreamList,
    '/setlist': SetList,
    '/aliases': Aliases,
    '/analytics': Analytics,
    '/profile': Profile,
    '/history': History,
    '/clothes': Clothes,
    '/clothes/:id': Clothes,
    '/discography': Discography,
    '/discography/:id': Discography,
  }

  const Current = $derived(PAGES[route.pattern] ?? NotFound)
</script>

<div class="min-h-dvh">
  <Navbar />

  <!-- key：換頁時重建元件，避免頁面殘留上一頁的區域狀態。
       用 route.page 而非 route.path——開／關詳細面板只是換動態段（/clothes ↔
       /clothes/20260611），拿 path 當 key 會把整頁重建：篩選狀態沒了、畫面閃一下，
       面板還會在重建後才由 $effect 重開 -->
  {#key route.page}
    <Current />
  {/key}

  <footer class="mx-auto max-w-[1440px] px-4 pb-8 pt-5 text-sm text-berry-fg-3">
    <div class="flex items-center justify-between gap-3 border-t border-berry-border pt-3">
      <span>非公式ファンサイト / Unofficial fan site</span>
      <!-- 本站自己的連結放頁尾，不與右上的官方渠道混排 -->
      {#each siteLinks as link (link.href)}
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-1.5 text-berry-fg-3 no-underline transition-colors hover:text-berry-fg-2"
        >
          {@html icons[link.icon]}
          {link.label}
        </a>
      {/each}
    </div>
  </footer>
</div>
