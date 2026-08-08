<script>
  // 沿革頁：讀 public/data/history.md（npm run snapshot 從現站 /pages/history.md 快照而來），
  // 自寫 mini markdown 解析（markdown.js）+ 純模板渲染（MarkdownView.svelte，無 innerHTML）。
  // 走本地快照＝同源同 CDN，不再繞 proxy 打線上站（用戶回饋：沿革載入明顯比原站慢）。
  import Page from '../lib/Page.svelte'
  import { t, getLang } from '../i18n.svelte.js'
  import { parseHistoryMarkdown } from '../lib/content/markdown.js'
  import MarkdownView from '../lib/content/MarkdownView.svelte'

  const msgs = {
    zh: { error: '沿革載入失敗', jump: '跳至年份' },
    en: { error: 'Failed to load history', jump: 'Jump to year' },
    ja: { error: '沿革の読み込みに失敗しました', jump: '年へジャンプ' },
  }
  const m = $derived(msgs[getLang()] ?? msgs.zh)

  /** @type {'loading' | 'error' | 'ready'} */
  let status = $state('loading')
  let blocks = $state([])

  async function load() {
    status = 'loading'
    try {
      const res = await fetch('/data/history.md')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      blocks = parseHistoryMarkdown(text)
      status = 'ready'
    } catch {
      status = 'error'
    }
  }

  load()

  const years = $derived(blocks.filter((b) => b.type === 'year').map((b) => b.year))
</script>

<Page title={t('page.history')}>
  {#if status === 'loading'}
    <div class="space-y-3">
      {#each Array(8) as _, i (i)}
        <div class="h-4 animate-pulse rounded bg-berry-bg-3" style="width: {90 - i * 6}%"></div>
      {/each}
    </div>
  {:else if status === 'error'}
    <div class="rounded-lg border border-berry-border bg-berry-bg-3 p-6 text-center">
      <p class="text-sm text-berry-fg-2">{m.error}</p>
      <button
        type="button"
        class="mt-3 rounded-md border border-berry-border px-3 py-1.5 text-sm transition-colors hover:bg-berry-bg-2"
        onclick={load}
      >
        {t('common.retry')}
      </button>
    </div>
  {:else}
    {#if years.length}
      <nav
        class="sticky top-14 z-20 -mx-4 mb-6 flex items-center gap-2 overflow-x-auto border-b border-berry-border bg-berry-bg/90 px-4 py-2 backdrop-blur-sm sm:mx-0 sm:rounded-lg sm:border sm:px-3"
      >
        <span class="shrink-0 text-sm text-berry-fg-3">{m.jump}</span>
        {#each years as y (y)}
          <a
            href="#year-{y}"
            class="shrink-0 rounded-full border border-berry-border px-3 py-1.5 text-sm no-underline text-berry-fg-2 transition-colors hover:bg-berry-bg-3 hover:text-berry-fg"
          >
            {y}
          </a>
        {/each}
      </nav>
    {/if}

    <MarkdownView {blocks} />
  {/if}
</Page>
