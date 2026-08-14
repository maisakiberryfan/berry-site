<script>
  // 個人資料頁（搬運自 fansite/pages/profile.htm + assets/js/profile.js）
  // 內容（facts/hashtags/三語自介/BGM 曲名與作曲者）皆照搬現站；版面重排為極簡卡片式。
  import Page from '../lib/Page.svelte'
  import { t, getLang } from '../i18n.svelte.js'
  import { assetUrl } from '../assets.js'

  const DEBUT_DATE = '2020-09-05'

  const hashtags = [
    { key: 'general', tag: '#苺咲べりぃ', href: 'https://x.com/search?q=%23%E8%8B%BA%E5%92%B2%E3%81%B9%E3%82%8A%E3%81%83' },
    { key: 'live', tag: '#べりなま', href: 'https://x.com/search?q=%23%E3%81%B9%E3%82%8A%E3%81%AA%E3%81%BE' },
    { key: 'fans', tag: '#べりマネ', href: 'https://x.com/search?q=%23%E3%81%B9%E3%82%8A%E3%83%9E%E3%83%8D' },
    { key: 'fanart', tag: '#べりあーと', href: 'https://x.com/search?q=%23%E3%81%B9%E3%82%8A%E3%81%82%E3%83%BC%E3%81%A8' },
    { key: 'patrol', tag: '#べりぃ監視中', href: 'https://x.com/search?q=%23%E3%81%B9%E3%82%8A%E3%81%83%E7%9B%A3%E8%A6%96%E4%B8%AD' },
    { key: 'food', tag: '#べりぃちゃん痩せて', href: 'https://x.com/search?q=%23%E3%81%B9%E3%82%8A%E3%81%83%E3%81%A1%E3%82%83%E3%82%93%E7%97%A9%E3%81%9B%E3%81%A6' },
  ]

  const bgmTracks = [
    { id: 1, composer: 'ねぎとろ。' },
    { id: 2, composer: 'ねぎとろ。' },
    { id: 3, composer: '菅原ショウ' },
    { id: 4, composer: '司/19G' },
    { id: 5, composer: '司/19G' },
  ]

  // 頁內局部三語字典（頁面專屬文案，不動共享字典檔）
  const msgs = {
    zh: {
      birthday: '生日',
      debut: '出道',
      height: '身高',
      age: '年齡',
      bloodType: '血型',
      origin: '出身',
      hashtagsHeading: '標籤',
      hashtag: { general: '一般', live: '直播', fans: '粉絲名', fanart: '粉絲繪', patrol: '巡回用', food: '飯テロ' },
      introHeading: 'Introduction',
      quote: '「來自草莓國、熱愛唱歌的偶像 VTuber！」',
      intro1: '2020年9月5日開始以 VTuber 身分活動。',
      intro2: '活動以 YouTube 歌回直播為主，也發行了收錄原創歌曲的 CD 等，專注於音樂活動。',
      logoHeading: 'Logo',
      bgmHeading: 'BGM',
      composer: '作曲',
    },
    en: {
      birthday: 'Birthday',
      debut: 'Debut',
      height: 'Height',
      age: 'Age',
      bloodType: 'Blood Type',
      origin: 'Nationality',
      hashtagsHeading: 'Hashtags',
      hashtag: { general: 'General', live: 'Live', fans: 'Fans', fanart: 'Fan art', patrol: 'For Patrol', food: 'Food' },
      introHeading: 'Introduction',
      quote: "“I'm an idol VTuber from the Strawberry Kingdom, and I love to sing!”",
      intro1: 'She began her VTuber career on September 5, 2020.',
      intro2:
        'She is mainly active through singing streams on YouTube, focusing on music work such as releasing CDs of her original songs.',
      logoHeading: 'Logo',
      bgmHeading: 'BGM',
      composer: 'Composer',
    },
    ja: {
      birthday: '誕生日',
      debut: '活動開始',
      height: '身長',
      age: '年齢',
      bloodType: '血液型',
      origin: '出身地',
      hashtagsHeading: 'ハッシュタグ',
      hashtag: { general: '一般', live: '生放送', fans: 'ファンネーム', fanart: 'ファンアート', patrol: '巡回用', food: '飯テロ' },
      introHeading: 'Introduction',
      quote: '「苺の国からやってきた、歌うことが大好きなアイドルVtuber！」',
      intro1: '2020年9月5日からVtuberとして活動開始。',
      intro2: 'youtubeでの歌枠配信を中心に活動しており、オリジナル楽曲を収録したCDを発売するなど音楽活動に力をいれている。',
      logoHeading: 'Logo',
      bgmHeading: 'BGM',
      composer: '作曲',
    },
  }

  const m = $derived(msgs[getLang()] ?? msgs.zh)

  // 出道時長即時計算（年/月/日，逐級借位——同 dayjs diff 鏈的算法）
  function diffYMD(fromISO, to) {
    const from = new Date(`${fromISO}T00:00:00`)
    let years = to.getFullYear() - from.getFullYear()
    let months = to.getMonth() - from.getMonth()
    let days = to.getDate() - from.getDate()
    if (days < 0) {
      months -= 1
      days += new Date(to.getFullYear(), to.getMonth(), 0).getDate()
    }
    if (months < 0) {
      years -= 1
      months += 12
    }
    return { years, months, days }
  }

  const debutDuration = $derived.by(() => {
    const { years, months, days } = diffYMD(DEBUT_DATE, new Date())
    const lang = getLang()
    if (lang === 'ja') return `${years}年${months}ヶ月${days}日`
    if (lang === 'en') return `${years}y ${months}m ${days}d`
    return `${years}年${months}個月${days}天`
  })

  let audioEl
  let playingId = $state(null)

  function playTrack(id) {
    if (!audioEl) return
    audioEl.src = assetUrl(`/img/profile/bgm/${id}.mp3`)
    audioEl.play().catch(() => {})
    playingId = id
  }
</script>

<Page title={t('page.profile')}>
  <!-- 頭像 + facts-grid -->
  <div class="grid gap-8 sm:grid-cols-[auto_1fr] sm:items-center">
    <img
      src={assetUrl('/img/profile/avatar-10th.webp')}
      width="220"
      height="220"
      alt="苺咲べりぃ"
      class="mx-auto size-44 rounded-full border border-berry-border object-cover sm:mx-0 sm:size-56"
    />

    <div>
      <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm sm:text-base">
        <span class="text-right text-berry-text-emphasis">{m.birthday}</span>
        <span>08/15</span>
        <span class="text-right text-berry-text-emphasis">{m.debut}</span>
        <span>{DEBUT_DATE}（{debutDuration}）</span>
        <span class="text-right text-berry-text-emphasis">{m.height}</span>
        <span>153cm</span>
        <span class="text-right text-berry-text-emphasis">{m.age}</span>
        <span>(10)15</span>
        <span class="text-right text-berry-text-emphasis">{m.bloodType}</span>
        <span>Ｂ</span>
        <span class="text-right text-berry-text-emphasis">{m.origin}</span>
        <span>いちごの国</span>
      </div>

      <div class="mt-5">
        <div class="mb-2 text-sm text-berry-fg-3">{m.hashtagsHeading}</div>
        <div class="flex flex-wrap gap-2">
          {#each hashtags as h (h.key)}
            <a
              href={h.href}
              target="_blank"
              rel="noopener noreferrer"
              class="rounded-full border border-berry-subtle-border bg-berry-subtle-bg px-3 py-1 text-sm text-berry-text-emphasis no-underline transition-opacity hover:opacity-80"
            >
              {m.hashtag[h.key]} {h.tag}
            </a>
          {/each}
        </div>
      </div>
    </div>
  </div>

  <!-- 三語自介引言 -->
  <section class="mt-10 rounded-xl border border-berry-border bg-berry-bg-3 p-6 text-center sm:p-8">
    <h2 class="text-sm font-medium uppercase tracking-wide text-berry-fg-3">{m.introHeading}</h2>
    <div class="mt-4">
      <blockquote class="inline-block border-l-2 border-berry-primary pl-4 text-left text-lg text-berry-text-emphasis">
        {m.quote}
      </blockquote>
    </div>
    <p class="mx-auto mt-4 max-w-xl text-base text-berry-fg-2">{m.intro1}</p>
    <p class="mx-auto mt-1 max-w-xl text-base text-berry-fg-2">{m.intro2}</p>
  </section>

  <!-- Logo -->
  <section class="mt-10">
    <h2 class="text-center text-sm font-medium uppercase tracking-wide text-berry-fg-3">{m.logoHeading}</h2>
    <div class="mt-4 grid gap-6 sm:grid-cols-2">
      <figure class="text-center">
        <img
          src={assetUrl('/img/profile/mainlogo.webp')}
          width="576"
          height="324"
          alt="main logo"
          class="mx-auto w-full max-w-md rounded-lg border border-berry-border"
        />
        <figcaption class="mt-2 text-sm text-berry-fg-3">main logo／来宮りお</figcaption>
      </figure>
      <figure class="text-center">
        <img
          src={assetUrl('/img/profile/symbol.webp')}
          width="324"
          height="324"
          alt="symbol logo"
          class="mx-auto w-full max-w-52 rounded-lg border border-berry-border"
        />
        <figcaption class="mt-2 text-sm text-berry-fg-3">symbol logo／ますだめぐみ</figcaption>
      </figure>
    </div>
  </section>

  <!-- BGM -->
  <section class="mt-10">
    <h2 class="text-center text-sm font-medium uppercase tracking-wide text-berry-fg-3">{m.bgmHeading}</h2>
    <div class="mx-auto mt-4 max-w-md rounded-xl border border-berry-border bg-berry-bg-3 p-3">
      <ul class="divide-y divide-berry-border">
        {#each bgmTracks as track (track.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-berry-bg-2"
              class:text-berry-link={playingId === track.id}
              class:font-medium={playingId === track.id}
              onclick={() => playTrack(track.id)}
            >
              <span>{playingId === track.id ? '♪ ' : ''}BGM{track.id}</span>
              <span class="text-sm text-berry-fg-3">{m.composer}：{track.composer}</span>
            </button>
          </li>
        {/each}
      </ul>
      <audio bind:this={audioEl} class="mt-3 w-full" controls preload="none"></audio>
    </div>
  </section>
</Page>
