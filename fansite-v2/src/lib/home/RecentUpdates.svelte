<script>
  // 最近更新：/data/changelog.json（快照，前 N 筆依語言取 msg）＋ /api/stats/last-updated（三表更新時間）
  //
  // changelog.json 現況是「單一物件」（現站 /commit 每次覆蓋最新一筆），
  // 但未來可能改成陣列 —— 兩種形狀都吃。
  import { apiGet } from '../../api/client.js'
  import { formatDateTime, formatDbTime, parseInlineLinks } from './util.js'

  /**
   * @type {{
   *   title: string, dataTitle: string, lang: string,
   *   limit?: number, emptyText?: string,
   * }}
   */
  let { title, dataTitle, lang = 'zh', limit = 5, emptyText = '' } = $props()

  let raw = $state([]) // [{ time, msg: {zh,en,ja} }]
  let stats = $state(null) // { streamlist, setlist, songlist }
  let loading = $state(true)

  const entries = $derived(
    raw.slice(0, limit).map((e) => ({
      time: e.time,
      tokens: parseInlineLinks(e?.msg?.[lang] || e?.msg?.zh || ''),
    })),
  )

  async function loadChangelog() {
    try {
      const res = await fetch('/data/changelog.json', { cache: 'default' })
      if (!res.ok) return
      const d = await res.json()
      const list = Array.isArray(d) ? d : d && d.msg ? [d] : []
      raw = list.filter((e) => e && e.msg)
    } catch {
      /* 靜態檔缺失不影響首頁其他內容 */
    }
  }

  async function loadStats() {
    try {
      const res = await apiGet('/api/stats/last-updated')
      if (res.data && typeof res.data === 'object') stats = res.data
    } catch {
      /* 忽略：更新時間只是輔助資訊 */
    }
  }

  $effect(() => {
    let alive = true
    Promise.allSettled([loadChangelog(), loadStats()]).then(() => {
      if (alive) loading = false
    })
    return () => {
      alive = false
    }
  })
</script>

<section class="rounded-xl border border-berry-border bg-berry-bg-3 p-3.5 sm:p-4">
  <h2 class="text-base font-semibold">{title}</h2>

  {#if loading && !entries.length}
    <div class="mt-3 space-y-3">
      {#each [0, 1] as i (i)}
        <div class="space-y-1.5">
          <div class="h-3 w-24 animate-pulse rounded bg-berry-bg-2"></div>
          <div class="h-3.5 w-4/5 animate-pulse rounded bg-berry-bg-2"></div>
        </div>
      {/each}
    </div>
  {:else if entries.length}
    <ul class="mt-2.5 space-y-2.5">
      {#each entries as entry, i (entry.time ?? i)}
        <li class="border-l-2 pl-3" style="border-color: var(--berry-subtle-border)">
          <div class="text-sm tabular-nums text-berry-fg-3">{formatDateTime(entry.time)}</div>
          <p class="mt-0.5 text-base leading-relaxed text-berry-fg-2">
            {#each entry.tokens as token}
              {#if token.href}
                <a href={token.href} target="_blank" rel="noopener noreferrer">{token.text}</a>
              {:else}{token.text}{/if}
            {/each}
          </p>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="mt-3 text-sm text-berry-fg-3">{emptyText}</p>
  {/if}

  {#if stats}
    <div class="mt-3.5 border-t border-berry-border pt-2.5">
      <div class="text-sm uppercase tracking-wide text-berry-fg-3">{dataTitle}</div>
      <dl class="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-berry-fg-3">
        <dt class="font-mono">streamlist</dt>
        <dd class="tabular-nums">{formatDbTime(stats.streamlist)}</dd>
        <dt class="font-mono">setlist</dt>
        <dd class="tabular-nums">{formatDbTime(stats.setlist)}</dd>
        <dt class="font-mono">songlist</dt>
        <dd class="tabular-nums">{formatDbTime(stats.songlist)}</dd>
      </dl>
    </div>
  {/if}
</section>
