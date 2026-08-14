<script>
  // 音樂作品（Discography）頁
  //
  // 版面：單頁三分節（非分頁籤）——專輯封面牆 → 單曲封面牆 → 客座演唱列表，
  // 頂部小錨點列可跳分節。點卡片開詳細面板（modal，比照 Clothes 的 pattern）。
  //
  // 本頁的核心價值＝把「作品曲目」與「歌枠實際演唱紀錄」接起來：
  // 曲目有 songID 時顯示 🎤N 鈕，就地展開該曲的演唱場次（連結直接跳 YTLink 的 ?t= 秒數）。
  // 資料源是既有的三層瀑布快取（setlist/songlist/streamlist），純客端過濾，不打新 API。
  // ⚠️ setlist／streamlist 延到第一次開詳細面板才載（ensureRecords）——封面牆用不到它們，
  //    進頁就拉 15k 列（冷快取 5MB＋）只為了面板裡的 🎤N 不划算。
  //
  // 曲名的單一事實來源是 songlist：有 songID 一律顯示 songIndex 的 songName，
  // 資料模組的 name 只在無 songID／songlist 尚未載入時作 fallback。
  //
  // 手機：本頁全部是瀏覽功能（無編輯入口），天然符合「手機唯讀」鐵則。
  import { untrack } from 'svelte'
  import Page from '../lib/Page.svelte'
  import { t, getLang } from '../i18n.svelte.js'
  import { route, navigate } from '../router.svelte.js'
  import { assetUrl } from '../assets.js'
  import { focusTrap } from '../lib/focusTrap.svelte.js'
  import { albums, singles, guests, releases, formatReleaseDate, ordinalSuffix } from './discographyData.js'
  import { songlist, streamlist, setlist, songIndex, streamTitleOf, safeYTLink } from '../api/store.svelte.js'
  import { formatDate } from '../lib/table/utils.js'

  const msgs = {
    zh: {
      hint: '點擊作品可查看曲目、製作名單，以及每首歌在歌枠的演唱紀錄。',
      summary: (a, s) => `${a} 張專輯 · ${s} 張單曲`,
      albums: '專輯',
      singles: '單曲',
      guests: '客座演唱',
      guestsHint: '參與他人作品／商業合作的演唱曲目。',
      albumOrdinal: (n) => `第 ${n} 張專輯`,
      // 卡片用的短版（與「單曲」對仗）——與面板同一套字典，別再走英文序數
      albumOrdinalShort: (n) => `第 ${n} 張`,
      single: '單曲',
      release: '發行日',
      official: '特設頁',
      stream: '配信',
      xfd: 'XFD 試聽',
      staff: '製作',
      tracks: '曲目',
      instNote: '另收錄各曲 instrumental 版',
      mv: 'MV',
      sungRecords: '演唱紀錄',
      sungTitle: (n) => `${n} 場演唱紀錄`,
      openInSetlist: '在歌單中查看 →',
      showingRecent: (shown, total) => `顯示最近 ${shown} 場，共 ${total} 場`,
      loadingRecords: '演唱紀錄載入中…',
      noRecords: '無演唱紀錄',
      partialRecords: '尚未取得完整紀錄',
      noStreamTitle: '（無場次標題）',
      noArchive: '無存檔',
      roleLabel: {
        lyrics: '作詞',
        music: '作曲',
        arrange: '編曲',
        vocal: '演唱',
        movie: '影像',
        illust: '插畫',
        sdIllust: 'SD 插畫',
        guitar: '吉他',
        mix: 'MIX',
        design: '設計',
        logo: 'Logo',
        emblem: '徽章',
        mastering: '母帶處理',
      },
      guestRole: { ed: '片尾曲', theme: '主題歌', feature: '參與演唱' },
      guestNote: { titleUnknownVoice: '曲名不明；另有部分配音演出' },
    },
    en: {
      hint: 'Click a release to see its tracks, credits, and where each song was sung on stream.',
      summary: (a, s) => `${a} albums · ${s} singles`,
      albums: 'Albums',
      singles: 'Singles',
      guests: 'Guest Appearances',
      guestsHint: 'Songs recorded for other artists’ works and commercial tie-ups.',
      albumOrdinal: (n) => `${ordinalSuffix(n)} Album`,
      albumOrdinalShort: (n) => `${ordinalSuffix(n)} Album`,
      single: 'Single',
      release: 'Released',
      official: 'Official Page',
      stream: 'Streaming',
      xfd: 'XFD Demo',
      staff: 'Credits',
      tracks: 'Tracks',
      instNote: 'Instrumental versions of all tracks included',
      mv: 'MV',
      sungRecords: 'Performances',
      sungTitle: (n) => `${n} performances`,
      openInSetlist: 'View in Set List →',
      showingRecent: (shown, total) => `Showing the latest ${shown} of ${total}`,
      loadingRecords: 'Loading performances…',
      noRecords: 'no performances',
      partialRecords: 'records not fully loaded',
      noStreamTitle: '(untitled stream)',
      noArchive: 'no archive',
      roleLabel: {
        lyrics: 'Lyrics',
        music: 'Music',
        arrange: 'Arrangement',
        vocal: 'Vocals',
        movie: 'Movie',
        illust: 'Illustration',
        sdIllust: 'SD Illustration',
        guitar: 'Guitar',
        mix: 'Mixing',
        design: 'Design',
        logo: 'Logo',
        emblem: 'Emblem',
        mastering: 'Mastering',
      },
      guestRole: { ed: 'Ending Theme', theme: 'Theme Song', feature: 'Featured Vocals' },
      guestNote: { titleUnknownVoice: 'Title unknown; also includes voice work' },
    },
    ja: {
      hint: '作品をクリックすると、収録曲・スタッフ・歌枠での歌唱記録が見られます。',
      summary: (a, s) => `アルバム ${a} 枚 · シングル ${s} 枚`,
      albums: 'アルバム',
      singles: 'シングル',
      guests: '参加楽曲',
      guestsHint: '他アーティストの作品・商業タイアップへの参加楽曲。',
      albumOrdinal: (n) => `${ordinalSuffix(n)}アルバム`,
      albumOrdinalShort: (n) => `${ordinalSuffix(n)}アルバム`,
      single: 'シングル',
      release: '発売日',
      official: '特設サイト',
      stream: '配信',
      xfd: 'XFD',
      staff: 'スタッフ',
      tracks: '収録曲',
      instNote: '各曲 instrumental 版収録',
      mv: 'MV',
      sungRecords: '歌唱記録',
      sungTitle: (n) => `歌唱記録 ${n} 件`,
      openInSetlist: 'セットリストで見る →',
      showingRecent: (shown, total) => `最新 ${shown} 件を表示（全 ${total} 件）`,
      loadingRecords: '歌唱記録を読み込み中…',
      noRecords: '歌唱記録なし',
      partialRecords: '歌唱記録は未取得',
      noStreamTitle: '（配信タイトルなし）',
      noArchive: 'アーカイブなし',
      roleLabel: {
        lyrics: '作詞',
        music: '作曲',
        arrange: '編曲',
        vocal: '歌',
        movie: 'Movie',
        illust: 'イラスト',
        sdIllust: 'SDイラスト',
        guitar: 'ギター',
        mix: 'MIX',
        design: 'デザイン',
        logo: 'ロゴ',
        emblem: 'エンブレム',
        mastering: 'マスタリング',
      },
      guestRole: { ed: 'ED主題歌', theme: '主題歌', feature: '参加' },
      guestNote: { titleUnknownVoice: '曲名不明・一部ボイス出演あり' },
    },
  }
  const m = $derived(msgs[getLang()] ?? msgs.zh)

  // 展開的歌唱紀錄一次最多列這麼多場，其餘引導到 setlist 頁（面板不該變成第二個表格）
  const MAX_RECORDS = 20

  // 封面牆只要曲名（songlist，~1k 列）。setlist（5MB＋／73 個月度檔）與 streamlist
  // 只有「面板內的歌唱紀錄」用得到，故延到第一次開面板才載——進頁不該為了 🎤N 拉全量。
  songlist.load()

  /** 歌唱紀錄資料的載入階段：'idle'（還沒人要）｜'loading'｜'ready'（load 已結束，成敗皆算） */
  let recordsPhase = $state('idle')

  /**
   * 第一次需要歌唱紀錄時才啟動 setlist／streamlist 的載入瀑布。
   * store.load() 本身冪等（重複呼叫回同一個 promise），這裡的 phase 只是用來收骨架：
   * 用 promise 的完成時機（allSettled ⇒ 失敗也算完成），骨架不會因為載入失敗而永轉。
   */
  function ensureRecords() {
    if (recordsPhase !== 'idle') return
    recordsPhase = 'loading'
    Promise.allSettled([setlist.load(), streamlist.load()]).then(() => {
      recordsPhase = 'ready'
    })
  }

  /** 開啟中的作品 id（'' = 未開啟） */
  let openId = $state('')
  /** 面板內展開歌唱紀錄的曲目索引（-1 = 未展開；換作品時重設） */
  let openTrack = $state(-1)
  /** 封面載入失敗的 id（圖未上線時走主題色佔位） */
  let broken = $state({})

  const openWork = $derived(openId ? (releases.find((w) => w.id === openId) ?? null) : null)

  /**
   * songID → 該曲的 setlist 列（新→舊）。
   * 索引建在原始的 setlist.rows 而非 setlistJoined.rows：場次標題只有展開的 ≤20 列要，
   * 為此讓 15k 列各展開成新物件不划算，標題改在渲染時逐列 streamTitleOf()。
   */
  const recordsBySong = $derived.by(() => {
    const map = new Map()
    for (const row of setlist.rows) {
      if (row.songID == null) continue
      const arr = map.get(row.songID)
      if (arr) arr.push(row)
      else map.set(row.songID, [row])
    }
    // time 是 ISO 字串，字典序＝時序；無時間（不留檔場）排最後
    for (const arr of map.values()) arr.sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')))
    return map
  })

  /**
   * 可以顯示場次數了嗎——有列可用就先顯示（IDB／快照 prime 完就有），
   * 或 load() 已結束（含失敗與真空）就不再等：兩者都不成立時才是骨架。
   */
  const recordsReady = $derived(recordsPhase === 'ready' || setlist.rows.length > 0)

  /**
   * 「0 場」到底是真的沒唱過，還是資料沒到齊？
   * setlist 的背景校正尚未成功（載入失敗、月度重抓有缺）時，rows 可能只是 IDB／快照的
   * 舊值甚至空的——這時候寫「無演唱紀錄」是在斷言一件我們並不知道的事，
   * 改說「尚未取得完整紀錄」。（不細看 isMonthComplete：這裡只要「別說謊」的粒度，
   * 逐月精度留給 SetList 頁。）
   */
  const recordsTrustworthy = $derived(setlist.synced)

  /** 曲名：有 songID 一律以 songlist 為準，其餘用資料模組的 name */
  function trackName(track) {
    if (track.songID != null) {
      const song = songIndex.map.get(track.songID)
      if (song?.songName) return song.songName
    }
    return track.name
  }

  function recordsOf(songID) {
    return songID == null ? [] : (recordsBySong.get(songID) ?? [])
  }

  /**
   * 「在歌單中查看」的站內連結。
   * 一律以 songID 傳（`?songID=`＝SetList 端對 songID 做精確等值過濾）——
   * 用曲名走快速搜尋是子字串比對，同名／含子字串的異曲會一起被撈進來
   * （かくれんぼ 167 會連優里 cover 168 一起出現，正是 alias 綁 songID 在防的互染）。
   * 無 songID 時才退回曲名（目前 UI 不會走到：沒有 songID 的曲目本來就不給連結）。
   */
  function setlistHref(songID, name) {
    if (songID != null) return `/setlist?songID=${encodeURIComponent(songID)}`
    return `/setlist?song=${encodeURIComponent(name ?? '')}`
  }

  /** 展開區的 DOM id（🎤 鈕的 aria-controls 要指到它） */
  function recordsDomId(workId, i) {
    return `disco-records-${workId}-${i}`
  }

  /** 一人兼多職＝職稱以斜線並列（英文介面用半形標點，中日用全形） */
  function creditText(credit) {
    const en = getLang() === 'en'
    const roles = (credit.roles ?? []).map((r) => m.roleLabel[r] ?? r).join(en ? ' / ' : '／')
    return roles ? `${roles}${en ? ': ' : '：'}${credit.name}` : credit.name
  }

  /** 本頁的總覽路徑（詳細頁＝其下再加一段作品 id） */
  const BASE_PATH = '/discography'

  function openDetail(id) {
    openId = id
    openTrack = -1
    ensureRecords()
    // 走 router 而非裸 history.replaceState：route.id 要跟著變，導覽列再點一次
    // 「音樂作品」時（pushState 回總覽路徑）面板才關得掉。
    // replace 而非 push：沿用改制前的行為——開著面板按上一頁是離開本頁，不是關面板
    navigate(`${BASE_PATH}/${encodeURIComponent(id)}${location.search}`, {
      replace: true,
      scroll: false,
    })
  }

  function closeDetail() {
    openId = ''
    openTrack = -1
    if (route.id) navigate(`${BASE_PATH}${location.search}`, { replace: true, scroll: false })
  }

  function toggleTrack(i) {
    openTrack = openTrack === i ? -1 : i
  }

  function scrollToSection(id) {
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // 焦點也要跟著走（section 帶 tabindex="-1"），否則鍵盤／讀屏使用者按了錨點還停在原處
    el.focus({ preventScroll: true })
  }

  // 路徑直達：/discography/<id>（如 /discography/rebirthr）直開該作品面板。
  // 認不得的 id ＝ 收掉面板顯示總覽（不轉 NotFound，理由見下方分支註解）。
  //
  // ⚠️ 本函式被 $effect 呼叫，兩處刻意切斷 reactive 依賴：
  //   1. `ensureRecords()` 讀 `recordsPhase`，若被收成 effect 的依賴，延遲載入完成
  //      （'loading' → 'ready'）就會讓 effect 重跑、把使用者剛展開的 🎤 列（openTrack）收掉。
  //   2. 讀 `openId` 同理（開面板本身會讓 effect 再跑一次），順便讓「同一個 id 重跑」
  //      不再重設 openTrack——雙保險，缺一都仍可能收合。
  function applyRouteId(raw) {
    const id = String(raw ?? '') // route.id 已 decodeURIComponent
    const current = untrack(() => openId)
    if (!id) {
      openId = ''
      openTrack = -1
      return
    }
    if (!releases.some((w) => w.id === id)) {
      // 認不得的 id：當作沒開面板（顯示總覽）。改制前的 hash 版在這裡是「不動作」
      // （怕動到別人的錨點），path 沒有這個顧慮——不收掉的話「開著面板時導到未知 id」
      // 會留著上一張作品，與直接開該網址的結果不一致
      if (current) {
        openId = ''
        openTrack = -1
      }
      return
    }
    if (current !== id) {
      openId = id
      openTrack = -1
    }
    untrack(() => ensureRecords())
  }

  // 面板狀態跟著 router 的動態段走：導覽列點同頁（pushState 回總覽路徑）不發任何
  // hashchange，只有 route.id 會變，靠這個 effect 收斂
  $effect(() => {
    applyRouteId(route.id)
  })

  // 舊 hash 連結相容：`/discography#rebirthr` → replace 成 `/discography/rebirthr`
  // （2026-08-14 由 hash 改 path 之前分享出去的網址）。hashchange 也掛著：手動在網址列
  // 改 hash 不會重新載入頁面，沒有這條的話舊格式在同一分頁內完全沒反應。
  // 只認「確實是作品 id」的 hash——其餘可能是別人的錨點（本頁分節錨點走捲動不寫 hash），不碰。
  function migrateLegacyHash() {
    let hash = String(location.hash || '').replace(/^#/, '')
    if (!hash) return
    try {
      hash = decodeURIComponent(hash)
    } catch {
      // 壞的 % 序列：拿原字串去比對（比不到就當作別人的錨點，不動作）
    }
    if (!releases.some((w) => w.id === hash)) return
    navigate(`${BASE_PATH}/${encodeURIComponent(hash)}${location.search}`, { replace: true, scroll: false })
  }

  $effect(() => {
    migrateLegacyHash()
    window.addEventListener('hashchange', migrateLegacyHash)
    return () => window.removeEventListener('hashchange', migrateLegacyHash)
  })

  // Esc 關閉詳細面板
  $effect(() => {
    if (!openId) return
    function onKey(e) {
      if (e.key === 'Escape') closeDetail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<!-- 封面（載入失敗→主題色漸層佔位，圖尚未上線時的正常路徑） -->
{#snippet cover(work, sizeClass)}
  {#if broken[work.id]}
    <div
      class="flex {sizeClass} items-center justify-center rounded-lg border border-berry-border p-2 text-center"
      style="background: linear-gradient(135deg, rgba(var(--berry-primary-rgb), .22), rgba(var(--berry-pink-rgb), .18))"
    >
      <span class="text-sm font-semibold text-berry-text-emphasis">{work.title}</span>
    </div>
  {:else}
    <img
      src={assetUrl(`/img/albums/${work.id}.webp`)}
      loading="lazy"
      alt={work.title}
      class="{sizeClass} rounded-lg border border-berry-border object-cover"
      onerror={() => (broken[work.id] = true)}
    />
  {/if}
{/snippet}

<!-- 封面牆卡片（專輯／單曲共用） -->
{#snippet card(work)}
  <button type="button" class="group text-left" onclick={() => openDetail(work.id)}>
    <div class="overflow-hidden rounded-lg transition-transform duration-200 group-hover:scale-[1.03]">
      {@render cover(work, 'aspect-square w-full')}
    </div>
    <p class="mt-1.5 text-sm font-medium">{work.title}</p>
    <p class="text-sm text-berry-fg-3">
      <span class="text-berry-text-emphasis">{work.ordinal ? m.albumOrdinalShort(work.ordinal) : m.single}</span>
      · {formatReleaseDate(work.releaseDate, getLang())}
    </p>
  </button>
{/snippet}

<!-- 製作名單／曲目 credit 的小字列 -->
{#snippet creditLine(credits)}
  {#if credits?.length}
    <p class="text-sm text-berry-fg-3">
      {#each credits as c, i (i)}<span class="whitespace-nowrap">{creditText(c)}</span>{#if i < credits.length - 1}<span
            class="px-1.5">·</span
          >{/if}{/each}
    </p>
  {/if}
{/snippet}

<!-- 歌唱紀錄：某 songID 的場次列表（就地展開用）；場次標題只有這 ≤20 列才查 -->
{#snippet records(songID, name, domId)}
  {@const rows = recordsOf(songID)}
  <div
    id={domId}
    class="mt-2 rounded-lg border border-berry-border bg-berry-bg-3 p-2"
    role="group"
    aria-label={m.sungRecords}
  >
    <ul class="divide-y divide-berry-border">
      {#each rows.slice(0, MAX_RECORDS) as row (`${row.streamID}/${row.segmentNo}/${row.trackNo}`)}
        {@const link = row.time ? safeYTLink(row) : null}
        {@const streamTitle = streamTitleOf(row.streamID)}
        <li>
          {#if link}
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              class="flex gap-2 rounded px-1.5 py-1.5 text-sm no-underline transition-colors hover:bg-berry-bg-2"
            >
              <span class="shrink-0 tabular-nums text-berry-fg-3">{formatDate(row.time)}</span>
              <span class="min-w-0 truncate">{streamTitle || m.noStreamTitle}</span>
            </a>
          {:else}
            <div class="flex gap-2 px-1.5 py-1.5 text-sm text-berry-fg-3">
              <span class="shrink-0">{m.noArchive}</span>
              <span class="min-w-0 truncate">{streamTitle || m.noStreamTitle}</span>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <div class="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1.5 text-sm">
      {#if rows.length > MAX_RECORDS}
        <span class="text-berry-fg-3">{m.showingRecent(MAX_RECORDS, rows.length)}</span>
      {:else}
        <span></span>
      {/if}
      <a href={setlistHref(songID, name)} class="no-underline hover:underline">{m.openInSetlist}</a>
    </div>
  </div>
{/snippet}

<Page title={t('page.discography')} subtitle={m.summary(albums.length, singles.length)}>
  <p class="mb-4 text-base text-berry-fg-3">{m.hint}</p>

  <!-- 分節錨點：純捲動（hash 保留給作品直達 #<id>，不與分節共用） -->
  <nav class="mb-5 flex flex-wrap gap-2">
    {#each [{ id: 'albums', label: m.albums }, { id: 'singles', label: m.singles }, { id: 'guests', label: m.guests }] as sec (sec.id)}
      <button
        type="button"
        class="rounded-full border border-berry-border px-3 py-1 text-sm text-berry-fg-2 transition-colors hover:bg-berry-bg-3"
        onclick={() => scrollToSection(sec.id)}
      >
        {sec.label}
      </button>
    {/each}
  </nav>

  <!-- tabindex="-1"：分節錨點捲動後把焦點移進來（scrollToSection），僅程式化聚焦不進 Tab 序 -->
  <section id="albums" tabindex="-1" class="scroll-mt-16 outline-none">
    <h2 class="mb-3 border-b border-berry-border pb-1.5 text-lg font-semibold">{m.albums}</h2>
    <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
      {#each albums as work (work.id)}
        {@render card(work)}
      {/each}
    </div>
  </section>

  <section id="singles" tabindex="-1" class="mt-8 scroll-mt-16 outline-none">
    <h2 class="mb-3 border-b border-berry-border pb-1.5 text-lg font-semibold">{m.singles}</h2>
    <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
      {#each singles as work (work.id)}
        {@render card(work)}
      {/each}
    </div>
  </section>

  <section id="guests" tabindex="-1" class="mt-8 scroll-mt-16 outline-none">
    <h2 class="mb-3 border-b border-berry-border pb-1.5 text-lg font-semibold">{m.guests}</h2>
    <p class="mb-3 text-sm text-berry-fg-3">{m.guestsHint}</p>
    <ul class="space-y-2">
      {#each guests as g (g.id)}
        <li class="rounded-lg border border-berry-border p-3">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span class="font-medium">{g.title ?? g.work}</span>
            {#if g.title}<span class="text-sm text-berry-fg-2">{g.work}</span>{/if}
            {#if g.roleKey}
              <span class="rounded-full border border-berry-subtle-border bg-berry-subtle-bg px-2 py-0.5 text-sm text-berry-text-emphasis">
                {m.guestRole[g.roleKey] ?? g.roleKey}
              </span>
            {/if}
            {#if g.date}<span class="text-sm text-berry-fg-3">{formatReleaseDate(g.date, getLang())}</span>{/if}
          </div>

          {#if g.tracks?.length}
            <ul class="mt-1.5 space-y-0.5 text-sm">
              {#each g.tracks as tr (tr.name)}
                <li class="flex items-baseline gap-2">
                  <span class="shrink-0 tabular-nums text-berry-fg-3">{String(tr.no).padStart(2, '0')}</span>
                  <span>{tr.name}</span>
                  {#if tr.youtube}
                    <a
                      href={`https://youtu.be/${tr.youtube}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-berry-fg-2 no-underline hover:underline"
                    >
                      ▶ {m.mv}
                    </a>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}

          {#if g.noteKey}
            <p class="mt-1 text-sm text-berry-fg-3">{m.guestNote[g.noteKey] ?? ''}</p>
          {/if}
          {@render creditLine(g.credits)}

          <div class="mt-1.5 flex flex-wrap items-center gap-3 text-sm">
            {#if g.links?.official}
              <a href={g.links.official} target="_blank" rel="noopener noreferrer" class="no-underline hover:underline">
                {g.work} ↗
              </a>
            {/if}
            {#if g.links?.stream}
              <a href={g.links.stream} target="_blank" rel="noopener noreferrer" class="no-underline hover:underline">
                {m.stream} ↗
              </a>
            {/if}
            {#if g.youtube}
              <a
                href={`https://youtu.be/${g.youtube}${g.startAt ? `?t=${g.startAt}` : ''}`}
                target="_blank"
                rel="noopener noreferrer"
                class="no-underline hover:underline"
              >
                ▶ {m.mv}
              </a>
            {/if}
            <!-- 連結本身只要 songID 就成立（精確過濾），不必等 setlist；
                 載好之後才知道場次數，才把數字補上（載好且為 0＝真的沒唱過，整條不顯示） -->
            {#if g.songID != null}
              {@const guestCount = recordsReady ? recordsOf(g.songID).length : -1}
              <!-- 0 場才整條收起來——但「資料還沒取齊的 0」不算數（見 recordsTrustworthy），
                   那時照樣給連結、只是不寫數字 -->
              {#if guestCount !== 0 || !recordsTrustworthy}
                <a href={setlistHref(g.songID, trackName({ songID: g.songID, name: g.title }))} class="no-underline hover:underline">
                  🎤 {guestCount > 0 ? `${guestCount} · ` : ''}{m.openInSetlist}
                </a>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </section>
</Page>

{#if openWork}
  {@const work = openWork}
  <div
    use:focusTrap={() => ({})}
    class="fixed inset-0 z-[45] flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="disco-detail-title"
    tabindex="-1"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeDetail()
    }}
    onkeydown={(e) => {
      if (e.key === 'Escape') closeDetail()
    }}
  >
    <div class="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-berry-border bg-berry-bg p-5 shadow-xl sm:p-6">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 id="disco-detail-title" class="text-lg font-semibold">{work.title}</h2>
          <p class="mt-0.5 text-sm text-berry-fg-3">
            {work.ordinal ? m.albumOrdinal(work.ordinal) : m.single} · {m.release}
            {formatReleaseDate(work.releaseDate, getLang())}
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-md p-1.5 text-berry-fg-2 transition-colors hover:bg-berry-bg-3 hover:text-berry-fg"
          aria-label={t('common.close')}
          onclick={closeDetail}
        >
          <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div class="mt-4 grid gap-5 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <div>
          {@render cover(work, 'aspect-square w-full max-w-[260px]')}

          {#if work.links?.official || work.links?.booth || work.links?.stream || work.links?.xfd}
            <div class="mt-3 flex flex-wrap gap-2">
              {#if work.links.official}
                <a
                  href={work.links.official}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="rounded-md border border-berry-border px-3 py-1.5 text-sm no-underline transition-colors hover:bg-berry-bg-3"
                >
                  {m.official} ↗
                </a>
              {/if}
              {#if work.links.booth}
                <a
                  href={work.links.booth}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="rounded-md border border-berry-border px-3 py-1.5 text-sm no-underline transition-colors hover:bg-berry-bg-3"
                >
                  BOOTH ↗
                </a>
              {/if}
              {#if work.links.stream}
                <a
                  href={work.links.stream}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="rounded-md border border-berry-border px-3 py-1.5 text-sm no-underline transition-colors hover:bg-berry-bg-3"
                >
                  {m.stream} ↗
                </a>
              {/if}
              {#if work.links.xfd}
                <a
                  href={`https://youtu.be/${work.links.xfd}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="rounded-md border border-berry-border px-3 py-1.5 text-sm no-underline transition-colors hover:bg-berry-bg-3"
                >
                  ▶ {m.xfd} ↗
                </a>
              {/if}
            </div>
          {/if}

          {#if work.staff?.length}
            <div class="mt-3">
              <div class="mb-1 text-sm text-berry-text-emphasis">{m.staff}</div>
              {@render creditLine(work.staff)}
            </div>
          {/if}
        </div>

        <div>
          <div class="mb-2 text-sm text-berry-text-emphasis">{m.tracks}</div>
          <ol class="divide-y divide-berry-border">
            {#each work.tracks as track, i (i)}
              {@const name = trackName(track)}
              {@const count = recordsReady ? recordsOf(track.songID).length : 0}
              {@const recId = recordsDomId(work.id, i)}
              <li class="py-2">
                <div class="flex items-baseline gap-2">
                  <span class="shrink-0 tabular-nums text-berry-fg-3">{String(i + 1).padStart(2, '0')}</span>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-baseline gap-2">
                      <span class="font-medium">{name}</span>
                      {#if track.youtube}
                        <a
                          href={`https://youtu.be/${track.youtube}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="rounded-full border border-berry-border px-2 py-0.5 text-sm text-berry-fg-2 no-underline transition-colors hover:bg-berry-bg-3"
                        >
                          ▶ {m.mv}
                        </a>
                      {/if}
                      {#if track.songID != null && recordsReady && count > 0}
                        <button
                          type="button"
                          class="rounded-full border px-2 py-0.5 text-sm transition-colors"
                          class:border-berry-primary={openTrack === i}
                          class:bg-berry-subtle-bg={openTrack === i}
                          class:text-berry-text-emphasis={openTrack === i}
                          class:border-berry-border={openTrack !== i}
                          class:text-berry-fg-2={openTrack !== i}
                          title={m.sungTitle(count)}
                          aria-label={m.sungTitle(count)}
                          aria-expanded={openTrack === i}
                          aria-controls={recId}
                          onclick={() => toggleTrack(i)}
                        >
                          🎤 {count}
                        </button>
                      {:else if track.songID != null && !recordsReady}
                        <span
                          class="inline-block h-5 w-10 animate-pulse rounded-full bg-berry-bg-3"
                          role="status"
                          aria-label={m.loadingRecords}
                        ></span>
                      {:else if track.songID != null}
                        <!-- 載完了但這首沒有紀錄——骨架不留在那裡轉。校正沒成功時只敢說
                             「還沒取齊」，不敢說「沒唱過」 -->
                        <span class="text-sm text-berry-fg-3">
                          {recordsTrustworthy ? m.noRecords : m.partialRecords}
                        </span>
                      {/if}
                    </div>
                    {@render creditLine(track.credits)}
                    {#if openTrack === i}
                      {@render records(track.songID, name, recId)}
                    {/if}
                  </div>
                </div>
              </li>
            {/each}
          </ol>
          {#if work.instrumental || work.bonusTracks?.length}
            <p class="mt-2 text-sm text-berry-fg-3">
              {#if work.instrumental}{m.instNote}{/if}{#if work.instrumental && work.bonusTracks?.length}　·　{/if}{#if work.bonusTracks?.length}＋ {work.bonusTracks.join('、')}{/if}
            </p>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}
