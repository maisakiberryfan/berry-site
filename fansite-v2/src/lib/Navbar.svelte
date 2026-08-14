<script>
  // 導覽列：品牌名 + 桌面下拉分組 / 手機 hamburger + 語言下拉選單 + 主題切換鈕
  // 版面原則：極簡、hairline、留白；顏色一律走 app.css 的 berry tokens，禁止硬編亮/暗前提色
  import { brand, groups, externalLinks } from '../nav.js'
  import { icons } from './icons.js'
  import { pickLabel, t, setLang, getLang, LANGS, LANG_LABELS } from '../i18n.svelte.js'
  import { theme, toggleTheme } from '../theme.svelte.js'
  import { route } from '../router.svelte.js'

  let openGroup = $state(-1)
  let mobileOpen = $state(false)
  let langOpen = $state(false)

  // 目前頁：比對 route.page（樣式去掉動態段）——`/clothes/20260611` 這種詳細頁
  // 深連結仍要讓導覽列的「衣裝」保持在作用中，拿 route.path 比會漏掉
  const isActive = (href) => route.page === href

  function closeAll() {
    openGroup = -1
    mobileOpen = false
    langOpen = false
  }

  function toggleGroup(i) {
    langOpen = false
    openGroup = openGroup === i ? -1 : i
  }

  function toggleLang() {
    openGroup = -1
    langOpen = !langOpen
  }

  function chooseLang(code) {
    setLang(code)
    langOpen = false
  }

  // 點外面 / Esc 關閉；導覽後也關閉
  $effect(() => {
    if (openGroup === -1 && !mobileOpen && !langOpen) return
    const onPointer = (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-nav-root]')) closeAll()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') closeAll()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  })

  // 路徑一變就收起所有面板
  $effect(() => {
    route.path
    closeAll()
  })
</script>

<header
  data-nav-root
  class="sticky top-0 z-40 border-b border-berry-border bg-berry-bg/90 backdrop-blur-sm"
>
  <!-- navbar 頂端漸層線（裝飾層，同現站 theme-berry） -->
  <div
    class="h-px w-full"
    style="background: linear-gradient(90deg, transparent, var(--berry-primary), transparent); opacity: .55"
  ></div>

  <!-- 與列表頁的 wide 容器同寬（chrome 比窄內容寬是常見版式，反過來才突兀） -->
  <div class="mx-auto flex h-14 max-w-[1440px] items-center gap-2 px-4">
    <a
      href={brand.href}
      class="mr-2 shrink-0 text-xl font-semibold tracking-tight no-underline"
      style="color: var(--berry-brand)"
    >
      {pickLabel(brand)}
    </a>

    <!-- 桌面：分組下拉 -->
    <nav class="hidden items-center gap-0.5 md:flex">
      {#each groups as group, i (group.label)}
        <div class="relative">
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xl text-berry-fg-2 transition-colors hover:bg-berry-bg-3 hover:text-berry-fg"
            aria-expanded={openGroup === i}
            onclick={() => toggleGroup(i)}
          >
            {#if group.icon}{@html icons[group.icon]}{/if}
            {pickLabel(group)}
            <svg viewBox="0 0 24 24" class="size-3 opacity-60" aria-hidden="true">
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5"
                stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>

          {#if openGroup === i}
            <div
              class="absolute left-0 top-full z-50 mt-1 min-w-44 rounded-lg border border-berry-border bg-berry-bg py-1 shadow-lg"
            >
              {#each group.items as item, j (item.href ?? `divider-${j}`)}
                {#if item.divider}
                  <div class="my-1 h-px bg-berry-border"></div>
                {:else}
                  <a
                    href={item.href}
                    target={item.external ? '_blank' : undefined}
                    rel={item.external ? 'noopener noreferrer' : undefined}
                    class="block px-3 py-1.5 text-base no-underline transition-colors hover:bg-berry-bg-3"
                    class:font-medium={isActive(item.href)}
                    style={isActive(item.href) ? 'color: var(--berry-link)' : 'color: var(--berry-fg)'}
                  >
                    {pickLabel(item)}
                    {#if item.external}
                      <span class="ml-1 align-middle text-[10px] opacity-50">↗</span>
                    {/if}
                  </a>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </nav>

    <div class="ml-auto flex items-center gap-1">
      <!-- 桌面：外部連結（icon-only 同現站；padding 撐出可點面積） -->
      <div class="mr-0.5 hidden items-center lg:flex">
        {#each externalLinks as link (link.href)}
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            title={pickLabel(link)}
            aria-label={pickLabel(link)}
            class="flex items-center gap-1.5 rounded-md px-2 py-2 text-berry-fg-3 no-underline transition-colors hover:bg-berry-bg-3 hover:text-berry-fg"
            style={link.iconColor ? `color: ${link.iconColor}` : ''}
          >
            {@html icons[link.icon]}
            <!-- 字級對齊左側分組鈕（text-xl），兩側視覺才一致 -->
            {#if link.showLabel}<span class="text-xl">{pickLabel(link)}</span>{/if}
          </a>
        {/each}
      </div>

      <!-- 語言下拉選單（三語直選，不再循環切換） -->
      <div class="relative">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md px-2 py-2 text-xl text-berry-fg-2 transition-colors hover:bg-berry-bg-3 hover:text-berry-fg"
          title={t('common.language')}
          aria-label={t('common.language')}
          aria-haspopup="menu"
          aria-expanded={langOpen}
          onclick={toggleLang}
        >
          <svg viewBox="0 0 24 24" class="size-5" aria-hidden="true" fill="none"
            stroke="currentColor" stroke-width="1.7">
            <circle cx="12" cy="12" r="9" />
            <ellipse cx="12" cy="12" rx="4" ry="9" />
            <path d="M3.4 9h17.2M3.4 15h17.2" stroke-linecap="round" />
          </svg>
          <!-- lg 才顯示語言文字：768~1023px 區間（英文介面）會把 navbar 撐到橫向溢出 -->
          <span class="hidden lg:inline">{LANG_LABELS[getLang()]}</span>
          <svg viewBox="0 0 24 24" class="size-3 opacity-60" aria-hidden="true">
            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5"
              stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>

        {#if langOpen}
          <div
            class="absolute right-0 top-full z-50 mt-1 min-w-32 rounded-lg border border-berry-border bg-berry-bg py-1 shadow-lg"
            role="menu"
          >
            {#each LANGS as code (code)}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={getLang() === code}
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-base transition-colors hover:bg-berry-bg-3"
                class:font-medium={getLang() === code}
                style={getLang() === code
                  ? 'color: var(--berry-link); background: var(--berry-bg-3)'
                  : 'color: var(--berry-fg)'}
                onclick={() => chooseLang(code)}
              >
                <span class="w-3 shrink-0" aria-hidden="true">{getLang() === code ? '✓' : ''}</span>
                {LANG_LABELS[code]}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- 主題切換鈕 -->
      <button
        type="button"
        class="rounded-md p-1.5 text-berry-fg-2 transition-colors hover:bg-berry-bg-3 hover:text-berry-fg"
        title={theme.isDark ? t('common.themeLight') : t('common.themeDark')}
        aria-label={t('common.theme')}
        onclick={toggleTheme}
      >
        {#if theme.isDark}
          <!-- 目前暗色 → 顯示太陽（點了變亮） -->
          <svg viewBox="0 0 24 24" class="size-5" aria-hidden="true" fill="none"
            stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
          </svg>
        {:else}
          <!-- 目前亮色 → 顯示月亮（點了變暗） -->
          <svg viewBox="0 0 24 24" class="size-5" aria-hidden="true" fill="none"
            stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
            <path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8z" />
          </svg>
        {/if}
      </button>

      <!-- 手機 hamburger -->
      <button
        type="button"
        class="rounded-md p-1.5 text-berry-fg-2 transition-colors hover:bg-berry-bg-3 hover:text-berry-fg md:hidden"
        aria-expanded={mobileOpen}
        aria-label={t('common.menu')}
        onclick={() => (mobileOpen = !mobileOpen)}
      >
        <svg viewBox="0 0 24 24" class="size-5" aria-hidden="true" fill="none"
          stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
          {#if mobileOpen}
            <path d="M6 6l12 12M18 6L6 18" />
          {:else}
            <path d="M4 7h16M4 12h16M4 17h16" />
          {/if}
        </svg>
      </button>
    </div>
  </div>

  <!-- 手機展開面板：分組攤平 -->
  {#if mobileOpen}
    <div class="border-t border-berry-border bg-berry-bg px-4 pb-4 md:hidden">
      {#each groups as group (group.label)}
        <div class="mt-3">
          <div class="px-1 pb-1 text-sm uppercase tracking-wide text-berry-fg-3">
            {pickLabel(group)}
          </div>
          {#each group.items.filter((it) => !it.divider) as item (item.href)}
            <a
              href={item.href}
              target={item.external ? '_blank' : undefined}
              rel={item.external ? 'noopener noreferrer' : undefined}
              class="block rounded-md px-2 py-2 text-base no-underline transition-colors hover:bg-berry-bg-3"
              style={isActive(item.href) ? 'color: var(--berry-link)' : 'color: var(--berry-fg)'}
            >
              {pickLabel(item)}
              {#if item.external}
                <span class="ml-1 text-[10px] opacity-50">↗</span>
              {/if}
            </a>
          {/each}
        </div>
      {/each}

      <!-- 手機：語言三選一（與桌面下拉同語意） -->
      <div class="mt-4 border-t border-berry-border pt-3">
        <div class="px-1 pb-1 text-sm uppercase tracking-wide text-berry-fg-3">
          {t('common.language')}
        </div>
        <div class="flex flex-wrap gap-2">
          {#each LANGS as code (code)}
            <button
              type="button"
              aria-pressed={getLang() === code}
              class="rounded-md border px-3 py-2 text-xl transition-colors"
              style={getLang() === code
                ? 'background: var(--berry-subtle-bg); border-color: var(--berry-subtle-border); color: var(--berry-text-emphasis)'
                : 'background: var(--berry-bg-3); border-color: var(--berry-border); color: var(--berry-fg)'}
              onclick={() => chooseLang(code)}
            >
              {LANG_LABELS[code]}
            </button>
          {/each}
        </div>
      </div>

      <div class="mt-4 flex flex-wrap gap-x-2 gap-y-1 border-t border-berry-border pt-3">
        {#each externalLinks as link (link.href)}
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-2 rounded-md px-2 py-2 text-xl text-berry-fg-3 no-underline transition-colors hover:bg-berry-bg-3"
            style={link.iconColor ? `color: ${link.iconColor}` : ''}
          >
            {@html icons[link.icon]}
            {pickLabel(link)}
          </a>
        {/each}
      </div>
    </div>
  {/if}
</header>
