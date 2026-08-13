<script>
  // 首頁：hero（站名＋最新影片）→ 入口卡片格 → 最近更新 / 資料更新時間
  //
  // 文案走「頁內局部字典」（不動共享字典檔，避免與並行開發的頁面衝突）。
  import { getLang, pickLabel, t } from '../i18n.svelte.js'
  import { brand } from '../nav.js'
  import { songlist, streamlist, setlist, ytLatest } from '../api/store.svelte.js'
  import { apiGet, fetchSnapshot } from '../api/client.js'
  import HeroCard from '../lib/home/HeroCard.svelte'
  import EntryCard from '../lib/home/EntryCard.svelte'
  import RecentUpdates from '../lib/home/RecentUpdates.svelte'

  /* ---------- 頁內三語字典 ---------- */
  const msgs = {
    zh: {
      tagline: '非官方粉絲網站・資料倉庫',
      sourcePrefix: '資料來源：',
      latest: '最新影片',
      watch: '在 YouTube 觀看',
      noVideo: '目前沒有影片資料',
      explore: '探索',
      recent: '最近更新',
      dataUpdated: '資料更新時間',
      noChangelog: '沒有更新紀錄',
      unit: { songs: '首', streams: '場', entries: '筆' },
      cards: {
        songlist: '曲庫：曲名、歌手、類型與連動作品',
        streamlist: '直播與影片一覽，含縮圖與分類',
        setlist: '每場歌枠唱了哪些歌，點日期直接跳到該段',
        analytics: '演唱次數排行、月度趨勢與曲風分佈',
      },
    },
    en: {
      tagline: 'Unofficial fan site & data archive',
      sourcePrefix: 'Data from ',
      latest: 'Latest video',
      watch: 'Watch on YouTube',
      noVideo: 'No video data yet',
      explore: 'Explore',
      recent: 'Recent updates',
      dataUpdated: 'Data last updated',
      noChangelog: 'No changelog yet',
      unit: { songs: 'songs', streams: 'streams', entries: 'entries' },
      cards: {
        songlist: 'Song library: titles, artists, genres and tie-ins',
        streamlist: 'Streams and videos with thumbnails and categories',
        setlist: 'What was sung in each karaoke stream — click the date to jump to it',
        analytics: 'Rankings, monthly trends and genre mix',
      },
    },
    ja: {
      tagline: '非公式ファンサイト・データ倉庫',
      sourcePrefix: 'データ元：',
      latest: '最新動画',
      watch: 'YouTube で見る',
      noVideo: '動画データがありません',
      explore: 'コンテンツ',
      recent: '最近の更新',
      dataUpdated: 'データ更新時刻',
      noChangelog: '更新履歴がありません',
      unit: { songs: '曲', streams: '本', entries: '件' },
      cards: {
        songlist: '楽曲データ：曲名・アーティスト・ジャンル・タイアップ',
        streamlist: '配信・動画の一覧（サムネイル＋カテゴリ）',
        setlist: '各歌枠の曲目、日付クリックでその場面へジャンプ',
        analytics: '歌唱回数ランキング・月別推移・ジャンル分布',
      },
    },
  }
  const m = $derived(msgs[getLang()] ?? msgs.zh)

  // 歌單資料現由 YouTube 留言時間戳自動解析；兩個 wiki 為歷史彙整來源
  const SOURCES = [
    { label: 'YouTube 留言' },
    { label: '苺咲べりぃ非公式wiki @ seesaawiki', href: 'https://seesaawiki.jp/maisakiberry/' },
    { label: '苺咲べりぃWiki @ HackMD', href: 'https://hackmd.io/@MaisakiBerry' },
  ]

  /* ---------- 資料 ---------- */
  // 首頁只載兩張小表（songlist 32KB / streamlist 57KB）；
  // setlist 筆數改讀 manifest（869B）而非拉整份月度快取——首頁不值得為一個數字抓 70+ 個檔。
  ytLatest.load()
  songlist.load()
  streamlist.load()

  let manifestCount = $state(null)

  async function loadSetlistCount() {
    const snap = await fetchSnapshot('manifest.json')
    if (Array.isArray(snap?.months)) {
      manifestCount = snap.months.reduce((sum, x) => sum + (Number(x.count) || 0), 0)
      return
    }
    try {
      const res = await apiGet('/api/setlist/manifest')
      if (Array.isArray(res.data?.months)) {
        manifestCount = res.data.months.reduce((sum, x) => sum + (Number(x.count) || 0), 0)
      }
    } catch {
      /* 首頁數字缺一個不致命，卡片直接不顯示數字 */
    }
  }
  loadSetlistCount()

  /** 載入中（尚無資料）→ null 讓卡片顯示 skeleton；載完真的是 0 就顯示 0 */
  const countOf = (store) => (store.rows.length ? store.rows.length : store.loading ? null : 0)
  const setlistCount = $derived(setlist.rows.length || manifestCount)

  const cards = $derived([
    {
      href: '/songlist',
      title: t('page.songlist'),
      description: m.cards.songlist,
      count: countOf(songlist),
      unit: m.unit.songs,
      loading: songlist.loading,
    },
    {
      href: '/streamlist',
      title: t('page.streamlist'),
      description: m.cards.streamlist,
      count: countOf(streamlist),
      unit: m.unit.streams,
      loading: streamlist.loading,
    },
    {
      href: '/setlist',
      title: t('page.setlist'),
      description: m.cards.setlist,
      count: setlistCount ?? null,
      unit: m.unit.entries,
      loading: setlistCount == null,
    },
    {
      href: '/analytics',
      title: t('page.analytics'),
      description: m.cards.analytics,
      count: null,
      unit: '',
      loading: false,
    },
  ])
</script>

<main class="mx-auto max-w-6xl px-4 py-6 sm:py-7">
  <!-- Hero -->
  <section class="grid items-center gap-5 lg:grid-cols-[1.1fr_1fr] lg:gap-8">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{pickLabel(brand)}</h1>
      <p class="mt-1.5 text-base" style="color: var(--berry-link)">{m.tagline}</p>

      <!-- 品牌 hairline（同 navbar 漸層語彙） -->
      <div
        class="mt-3 h-px w-24"
        style="background: linear-gradient(90deg, var(--berry-primary), transparent)"
      ></div>

      <p class="mt-2.5 text-base text-berry-fg-3">
        {m.sourcePrefix}
        {#each SOURCES as source, i (source.label)}
          {#if i > 0}<span class="mx-1">·</span>{/if}
          {#if source.href}
            <a href={source.href} target="_blank" rel="noopener noreferrer">{source.label}</a>
          {:else}
            <span>{source.label}</span>
          {/if}
        {/each}
      </p>
    </div>

    <HeroCard
      video={ytLatest.value}
      loading={ytLatest.loading}
      label={m.latest}
      watchText={m.watch}
      emptyText={m.noVideo}
    />
  </section>

  <!-- 入口卡片格 -->
  <section class="mt-7 sm:mt-8">
    <h2 class="text-sm uppercase tracking-wide text-berry-fg-3">{m.explore}</h2>
    <div class="mt-2.5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
      {#each cards as card (card.href)}
        <EntryCard
          href={card.href}
          title={card.title}
          description={card.description}
          count={card.count}
          unit={card.unit}
          loading={card.loading}
        />
      {/each}
    </div>
  </section>

  <!-- 最近更新 + 資料更新時間 -->
  <section class="mt-7 sm:mt-8">
    <RecentUpdates
      title={m.recent}
      dataTitle={m.dataUpdated}
      lang={getLang()}
      emptyText={m.noChangelog}
    />
  </section>
</main>
