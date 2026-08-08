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
  import NotFound from './pages/NotFound.svelte'

  startRouter()

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
  }

  const Current = $derived(PAGES[route.path] ?? NotFound)
</script>

<div class="min-h-dvh">
  <Navbar />

  <!-- key：換頁時重建元件，避免頁面殘留上一頁的區域狀態 -->
  {#key route.path}
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
