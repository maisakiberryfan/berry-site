<script>
  // 分析頁：完全在瀏覽器端聚合既有快取資料（不打分析用 API，也沒有外部資料管線）。
  // 資料量 ~16k 列，$derived 重算是毫秒級。
  //
  // 版面：頁內兩個分頁籤——「統計」（統計卡＋圖表）與「資料查詢」（查詢面板）。
  //       查詢面板以前埋在整頁最底下沒人看得到，改成籤之後兩者都在第一屏。
  //       URL hash #query 可直達查詢籤（切籤走 replaceState，分享連結可直達）。
  //
  // 統計口徑（顯示在各卡片的 caption，這裡再記一次）：
  //   總歌曲數   = songlist 列數（曲庫收錄曲目）
  //   總演唱次數 = setlist 列數（同一首唱 N 次算 N 次）
  //   總場次數   = streamlist 列數（直播＋投稿影片＋Shorts，即「登錄影片數」）
  //   歌枠場數   = streamlist 中 categories 任一項含「歌枠」者
  //   月份分桶   = time 字串前 7 碼（UTC 月份，與後端 setlist 月度分段同語意）
  import Page from '../lib/Page.svelte'
  import { t, getLang } from '../i18n.svelte.js'
  import { songlist, streamlist, setlist, songIndex, loadAll } from '../api/store.svelte.js'
  import ChartCard from '../lib/charts/ChartCard.svelte'
  import StatTile from '../lib/charts/StatTile.svelte'
  import BarChart from '../lib/charts/BarChart.svelte'
  import ColumnChart from '../lib/charts/ColumnChart.svelte'
  import LineChart from '../lib/charts/LineChart.svelte'
  import { formatNumber } from '../lib/charts/format.js'

  /* ---------- 頁內三語字典 ---------- */
  const msgs = {
    zh: {
      subtitle: '歌枠統計・資料查詢',
      tabs: { stats: '統計', query: '資料查詢' },
      stat: {
        songs: '曲庫歌曲數',
        performances: '總演唱次數',
        streams: '總場次數',
        karaoke: '歌枠場數',
        songsHint: '收錄曲目總數',
        streamsHint: '直播＋投稿影片',
      },
      top: {
        title: '演唱次數排行 TOP 20',
        caption: '依 setlist 出現次數統計',
      },
      trend: {
        title: '月度趨勢（近 24 個月）',
        caption: '依直播／曲目的時間欄位分月統計',
        streams: '場次數',
        songs: '演唱曲數',
      },
      artist: { title: '歌手排行 TOP 10', caption: '依 setlist 的歌手欄位統計演唱次數' },
      unit: { songs: ' 首', times: ' 次', streams: ' 場' },
      retryHint: '資料載入失敗',
      query: {
        loading: '載入查詢面板…',
        failed: '查詢面板載入失敗',
        retry: '重新載入',
      },
    },
    en: {
      subtitle: 'Karaoke stats & data query',
      tabs: { stats: 'Stats', query: 'Data query' },
      stat: {
        songs: 'Songs in library',
        performances: 'Total performances',
        streams: 'Streams & videos',
        karaoke: 'Karaoke streams',
        songsHint: 'entries in the song library',
        streamsHint: 'live streams + uploads',
      },
      top: {
        title: 'Most performed — top 20',
        caption: 'By number of setlist entries',
      },
      trend: {
        title: 'Monthly trend (last 24 months)',
        caption: 'Grouped by the time field of streams / setlist entries',
        streams: 'Streams',
        songs: 'Songs performed',
      },
      artist: { title: 'Top artists — top 10', caption: 'Performance count by the artist field of setlist' },
      unit: { songs: ' songs', times: '', streams: '' },
      retryHint: 'Failed to load data',
      query: {
        loading: 'Loading query panel…',
        failed: 'Failed to load the query panel',
        retry: 'Try again',
      },
    },
    ja: {
      subtitle: '歌枠の統計・データ検索',
      tabs: { stats: '統計', query: 'データ検索' },
      stat: {
        songs: '登録楽曲数',
        performances: '総歌唱回数',
        streams: '配信・動画数',
        karaoke: '歌枠の回数',
        songsHint: '収録楽曲の総数',
        streamsHint: '配信＋投稿動画',
      },
      top: {
        title: '歌唱回数ランキング TOP 20',
        caption: 'セットリストの出現回数で集計',
      },
      trend: {
        title: '月別推移（直近 24 か月）',
        caption: '配信・曲目の時刻フィールドで月ごとに集計',
        streams: '配信・動画数',
        songs: '歌唱曲数',
      },
      artist: { title: 'アーティスト別 TOP 10', caption: 'セットリストのアーティスト欄で集計' },
      unit: { songs: ' 曲', times: ' 回', streams: ' 本' },
      retryHint: 'データの読み込みに失敗しました',
      query: {
        loading: '検索パネルを読み込み中…',
        failed: '検索パネルの読み込みに失敗しました',
        retry: '再読み込み',
      },
    },
  }

  const lang = $derived(getLang())
  const m = $derived(msgs[lang] ?? msgs.zh)

  /* ---------- 載入 ---------- */
  loadAll()

  const hasData = $derived(
    setlist.rows.length > 0 || songlist.rows.length > 0 || streamlist.rows.length > 0,
  )
  const busy = $derived(songlist.loading || streamlist.loading || setlist.loading)
  const failed = $derived(
    !hasData && !busy && !!(songlist.error || streamlist.error || setlist.error),
  )
  const placeholder = $derived(busy ? t('common.loadingData') : t('common.noData'))

  let retrying = $state(false)
  async function retry() {
    retrying = true
    await Promise.allSettled([songlist.reload(), streamlist.reload(), setlist.reload()])
    retrying = false
  }

  /* ---------- 聚合 ---------- */
  const isEn = $derived(lang === 'en')

  /** 分類欄位是多值陣列；只要有一項含「歌枠」就算歌枠場 */
  function hasKaraoke(categories) {
    if (Array.isArray(categories)) {
      return categories.some((c) => typeof c === 'string' && c.includes('歌枠'))
    }
    return typeof categories === 'string' && categories.includes('歌枠')
  }

  const stats = $derived({
    songs: songlist.rows.length,
    performances: setlist.rows.length,
    streams: streamlist.rows.length,
    karaoke: streamlist.rows.filter((s) => hasKaraoke(s.categories)).length,
  })

  const topSongs = $derived.by(() => {
    const counts = new Map()
    for (const r of setlist.rows) {
      if (r.songID == null) continue
      const entry = counts.get(r.songID)
      if (entry) entry.value += 1
      else counts.set(r.songID, { id: r.songID, value: 1, row: r })
    }
    const index = songIndex.map
    return [...counts.values()]
      .sort((a, b) => b.value - a.value)
      .slice(0, 20)
      .map((e) => {
        // songlist 是曲名的正本；setlist VIEW 的欄位當 fallback（曲被刪時仍能顯示）
        const s = index.get(e.id) ?? e.row
        const label = isEn
          ? s.songNameEn || s.songName || `#${e.id}`
          : s.songName || s.songNameEn || `#${e.id}`
        const artist = (isEn ? s.artistEn || s.artist : s.artist || s.artistEn) || ''
        return { label, value: e.value, hint: artist }
      })
  })

  const topArtists = $derived.by(() => {
    const counts = new Map()
    for (const r of setlist.rows) {
      const key = String(r.artist ?? '').trim()
      if (!key) continue
      const entry = counts.get(key)
      if (entry) {
        entry.value += 1
        if (!entry.en && r.artistEn) entry.en = r.artistEn
      } else {
        counts.set(key, { value: 1, ja: key, en: String(r.artistEn ?? '').trim() })
      }
    }
    return [...counts.values()]
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
      .map((e) => ({ label: isEn ? e.en || e.ja : e.ja, value: e.value }))
  })

  const TREND_MONTHS = 24

  /**
   * time（ISO UTC 字串）→ 使用者本地 'YYYY-MM'；不留檔場（time 為 null）不計入趨勢。
   * 與查詢寬表的 month 欄同語意（本地月）——同頁兩種月定義會讓跨月深夜場對不上
   * （main 側 625f67e 已統一，此處同步）。
   */
  function monthKeyOf(time) {
    if (typeof time !== 'string' || !time) return null
    const d = new Date(time)
    if (Number.isNaN(d.getTime())) return null
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }

  function monthsEndingAt(end, count) {
    const [y, mo] = end.split('-').map(Number)
    const out = []
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(y, mo - 1 - i, 1))
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
    }
    return out
  }

  const monthly = $derived.by(() => {
    const streamsBy = new Map()
    const songsBy = new Map()
    let latest = null
    const bump = (map, key) => {
      map.set(key, (map.get(key) ?? 0) + 1)
      if (!latest || key > latest) latest = key
    }
    for (const s of streamlist.rows) {
      const key = monthKeyOf(s.time)
      if (key) bump(streamsBy, key)
    }
    for (const r of setlist.rows) {
      const key = monthKeyOf(r.time)
      if (key) bump(songsBy, key)
    }
    if (!latest) return { keys: [], labels: [], streams: [], songs: [] }
    const keys = monthsEndingAt(latest, TREND_MONTHS)
    return {
      keys,
      labels: keys.map((k) => `${k.slice(2, 4)}/${k.slice(5, 7)}`),
      streams: keys.map((k) => streamsBy.get(k) ?? 0),
      songs: keys.map((k) => songsBy.get(k) ?? 0),
    }
  })

  const streamPoints = $derived(
    monthly.labels.map((label, i) => ({
      label,
      full: monthly.keys[i],
      value: monthly.streams[i],
    })),
  )

  /* ---------- 分頁籤 ---------- */
  const TABS = ['stats', 'query']
  let tab = $state('stats')

  // 進過查詢籤才掛載面板；掛載後就一直留著（切回統計不卸載，狀態才不會掉）
  let queryMounted = $state(false)

  function openTab(next) {
    tab = next
    if (next === 'query') {
      queryMounted = true
      loadQueryPanel()
    }
  }

  function syncFromHash() {
    openTab(location.hash === '#query' ? 'query' : 'stats')
  }

  function setTab(next) {
    if (!TABS.includes(next) || tab === next) return
    openTab(next)
    // 分享連結可直達，但切籤不該塞爆上一頁按鈕 ⇒ replaceState
    history.replaceState(history.state, '', next === 'query' ? '#query' : location.pathname + location.search)
  }

  /* ---------- 查詢面板（lazy） ----------
     面板走動態 import，主 bundle 增量為零；SQL 引擎（sql.js）再往下一層 lazy，
     直到使用者第一次按「執行查詢」才下載。開籤即載，另外在瀏覽器閒置時先預載，
     讓點籤當下不必等。 */
  let QueryPanel = $state(null)
  let panelLoading = $state(false)
  let panelFailed = $state(false)

  async function loadQueryPanel() {
    if (QueryPanel || panelLoading) return
    panelLoading = true
    panelFailed = false
    try {
      QueryPanel = (await import('../lib/analytics/QueryPanel.svelte')).default
    } catch {
      panelFailed = true
    } finally {
      panelLoading = false
    }
  }

  $effect(() => {
    syncFromHash()
    window.addEventListener('hashchange', syncFromHash)

    const idle =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback(() => loadQueryPanel(), { timeout: 3000 })
        : setTimeout(() => loadQueryPanel(), 1500)

    return () => {
      window.removeEventListener('hashchange', syncFromHash)
      if (typeof cancelIdleCallback === 'function' && typeof idle === 'number') cancelIdleCallback(idle)
      else clearTimeout(idle)
    }
  })
</script>

<Page title={t('page.analytics')} subtitle={m.subtitle} wide>
  <!-- 分頁籤（頁標題正下方，兩個入口一樣顯眼） -->
  <div class="mb-4 flex gap-1 border-b border-berry-border" role="tablist" aria-label={t('page.analytics')}>
    {#each TABS as id (id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === id}
        class="-mb-px border-b-2 px-4 py-2 text-base font-medium transition-colors {tab === id
          ? 'border-berry-primary text-berry-fg'
          : 'border-transparent text-berry-fg-3 hover:text-berry-fg-2'}"
        onclick={() => setTab(id)}
      >
        {m.tabs[id]}
      </button>
    {/each}
  </div>

  <!-- 兩個籤都保持掛載、以 hidden 切換：切回查詢籤時建構器設定與查詢結果還在 -->
  <div class={tab === 'stats' ? '' : 'hidden'}>
    {#if failed}
      <div class="rounded-xl border border-berry-border bg-berry-bg-3 p-8 text-center">
        <p class="text-sm text-berry-fg-2">{m.retryHint}</p>
        <button
          type="button"
          class="mt-3 rounded-md border border-berry-border px-3 py-1.5 text-sm transition-colors hover:bg-berry-bg-2 disabled:opacity-50"
          disabled={retrying}
          onclick={retry}
        >
          {retrying ? t('common.loading') : t('common.retry')}
        </button>
      </div>
    {:else}
      <!-- 總覽統計卡 -->
      <section class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={m.stat.songs}
          value={formatNumber(stats.songs)}
          hint={m.stat.songsHint}
          loading={!songlist.rows.length && busy}
        />
        <StatTile
          label={m.stat.performances}
          value={formatNumber(stats.performances)}
          loading={!setlist.rows.length && busy}
        />
        <StatTile
          label={m.stat.streams}
          value={formatNumber(stats.streams)}
          hint={m.stat.streamsHint}
          loading={!streamlist.rows.length && busy}
        />
        <StatTile
          label={m.stat.karaoke}
          value={formatNumber(stats.karaoke)}
          loading={!streamlist.rows.length && busy}
        />
      </section>

      <div class="mt-6 space-y-6">
        <!-- 演唱次數排行 -->
        <ChartCard
          title={m.top.title}
          caption={m.top.caption}
          empty={!topSongs.length}
          emptyText={placeholder}
        >
          <BarChart
            items={topSongs}
            color="var(--berry-primary)"
            valueSuffix={m.unit.times}
            ariaLabel={m.top.title}
          />
        </ChartCard>

        <!-- 月度趨勢：兩張共用月份軸的小圖（不做雙 y 軸，避免尺度誤讀） -->
        <ChartCard
          title={m.trend.title}
          caption={m.trend.caption}
          empty={!monthly.keys.length}
          emptyText={placeholder}
        >
          <div class="space-y-6">
            <div>
              <div class="mb-2 flex items-center gap-1.5 text-xs text-berry-fg-3">
                <span
                  class="inline-block size-2 rounded-full"
                  style="background: var(--berry-pink)"
                ></span>
                {m.trend.streams}
              </div>
              <ColumnChart
                points={streamPoints}
                color="var(--berry-pink)"
                valueSuffix={m.unit.streams}
                ariaLabel={m.trend.streams}
              />
            </div>

            <div>
              <div class="mb-2 flex items-center gap-1.5 text-xs text-berry-fg-3">
                <span
                  class="inline-block size-2 rounded-full"
                  style="background: var(--berry-primary)"
                ></span>
                {m.trend.songs}
              </div>
              <LineChart
                labels={monthly.labels}
                fullLabels={monthly.keys}
                series={[{ color: 'var(--berry-primary)', values: monthly.songs }]}
                valueSuffix={m.unit.times}
                ariaLabel={m.trend.songs}
              />
            </div>
          </div>
        </ChartCard>

        <!-- 歌手排行 -->
        <ChartCard
          title={m.artist.title}
          caption={m.artist.caption}
          empty={!topArtists.length}
          emptyText={placeholder}
        >
          <BarChart
            items={topArtists}
            color="var(--berry-pink)"
            valueSuffix={m.unit.times}
            maxLabelWidth={190}
            ariaLabel={m.artist.title}
          />
        </ChartCard>
      </div>
    {/if}
  </div>

  {#if QueryPanel && queryMounted}
    <div class={tab === 'query' ? '' : 'hidden'}>
      <QueryPanel />
    </div>
  {:else if tab === 'query'}
    <section class="rounded-xl border border-berry-border bg-berry-bg-3 p-8 text-center">
      <p class="text-sm text-berry-fg-3">{panelFailed ? m.query.failed : m.query.loading}</p>
      {#if panelFailed}
        <button
          type="button"
          class="mt-3 rounded-md border border-berry-border px-3 py-1.5 text-sm transition-colors hover:bg-berry-bg-2"
          onclick={loadQueryPanel}
        >
          {m.query.retry}
        </button>
      {/if}
    </section>
  {/if}
</Page>
