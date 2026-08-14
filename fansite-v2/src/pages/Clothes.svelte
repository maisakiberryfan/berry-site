<script>
  // 衣裝頁：搬運自 fansite/pages/clothes.htm + assets/js/clothes.js
  // 資料照搬進 clothesData.js；modal 換成自寫 detail 面板 + 自寫 Lightbox（不裝 Fancybox）。
  // hash 直達行為（#YYYYMMDD / #YYYYMMDD-N / 舊版 #YYYYMMDD_s）沿用現站邏輯。
  import Page from '../lib/Page.svelte'
  import Lightbox from '../lib/content/Lightbox.svelte'
  import { t, getLang } from '../i18n.svelte.js'
  import { clothesData, clothesDim, formatClothesDate, clothesGalleryImages } from './clothesData.js'
  import { assetUrl } from '../assets.js'
  import { focusTrap } from '../lib/focusTrap.svelte.js'

  const msgs = {
    zh: {
      hint: '點擊服裝看更多',
      clickToViewAll: '點擊立繪看全部圖片',
      expressions: '表情差分',
      debutDate: '發表日',
      designer: '設計',
      modeler: '建模',
      revealStream: '發表直播',
      turnaround: '四面圖',
    },
    en: {
      hint: 'Click on the outfit to see more',
      clickToViewAll: 'Click to view all images',
      expressions: 'Expressions',
      debutDate: 'Debut',
      designer: 'Design',
      modeler: 'Modeling',
      revealStream: 'Reveal Stream',
      turnaround: 'Turnaround',
    },
    ja: {
      hint: '衣装をクリックして、詳細をご覧ください',
      clickToViewAll: 'クリックで全画像を表示',
      expressions: '表情差分',
      debutDate: 'お披露目日',
      designer: 'デザイン',
      modeler: 'モデリング',
      revealStream: 'お披露目配信',
      turnaround: '四面図',
    },
  }
  const m = $derived(msgs[getLang()] ?? msgs.zh)

  let filter = $state('all') // 'all' | '2D' | '3D'
  let openIndex = $state(-1) // clothesData 索引，-1 = 未開啟
  let lightbox = $state(null) // { images, index } | null

  const filtered = $derived(clothesData.filter((it) => filter === 'all' || clothesDim(it) === filter))

  function openDetail(idx) {
    openIndex = idx
    history.replaceState(null, '', `#${clothesData[idx].date}`)
  }

  function closeDetail() {
    openIndex = -1
    if (location.hash) history.replaceState(null, '', location.pathname)
  }

  function openMainGallery(startIndex = 0) {
    const item = clothesData[openIndex]
    if (!item) return
    lightbox = { images: clothesGalleryImages(item, 's', item.count), index: startIndex }
  }

  function openFaceGallery(startIndex) {
    const item = clothesData[openIndex]
    if (!item) return
    lightbox = { images: clothesGalleryImages(item, 't', item.tCount), index: startIndex }
  }

  function openSideGallery() {
    const item = clothesData[openIndex]
    if (!item?.sideView) return
    lightbox = { images: clothesGalleryImages(item, 'c', item.sideView), index: 0 }
  }

  function closeLightbox() {
    lightbox = null
  }

  // Hash 直達：#YYYYMMDD 開詳細面板；#YYYYMMDD-N 直開 Lightbox 第 N 張立繪；
  // 舊版 #YYYYMMDD_s（四面圖 gallery 舊連結）→ 開詳細面板即可（四面圖入口已在面板內）
  function handleHash() {
    const hash = window.location.hash.slice(1)
    if (!hash) {
      openIndex = -1
      return
    }
    const parts = hash.split('-')
    const date = parts[0].replace(/_s$/, '')
    const idx = clothesData.findIndex((e) => e.date === date)
    if (idx === -1) return

    if (parts[1] && !parts[0].endsWith('_s')) {
      const item = clothesData[idx]
      const imgIndex = Math.max(0, parseInt(parts[1], 10) - 1)
      openIndex = idx
      lightbox = { images: clothesGalleryImages(item, 's', item.count), index: Math.min(imgIndex, item.count - 1) }
    } else {
      openIndex = idx
    }
  }

  $effect(() => {
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  })

  // Esc 關閉詳細面板（僅在 Lightbox 未開啟時掛聽，避免一次 Esc 同時關兩層）
  $effect(() => {
    if (openIndex === -1 || lightbox) return
    function onKey(e) {
      if (e.key === 'Escape') closeDetail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<Page title={t('page.clothes')}>
  <p class="mb-4 text-base text-berry-fg-3">{m.hint}</p>

  <div class="mb-5 flex gap-2">
    {#each ['all', '2D', '3D'] as f (f)}
      <button
        type="button"
        class="rounded-full border px-3 py-1 text-sm transition-colors"
        class:border-berry-primary={filter === f}
        class:bg-berry-subtle-bg={filter === f}
        class:text-berry-text-emphasis={filter === f}
        class:border-berry-border={filter !== f}
        class:text-berry-fg-2={filter !== f}
        onclick={() => (filter = f)}
      >
        {f === 'all' ? t('common.all') : f}
      </button>
    {/each}
  </div>

  <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
    {#each filtered as item (item.date)}
      <button type="button" class="group text-left" onclick={() => openDetail(clothesData.indexOf(item))}>
        <div class="overflow-hidden rounded-lg border border-berry-border bg-berry-bg-3">
          <img
            src={assetUrl(`/img/clothes/${item.date}/s1.webp`)}
            loading="lazy"
            alt={item.name}
            width="324"
            height="576"
            class="aspect-[9/16] w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
          />
        </div>
        <p class="mt-1.5 text-sm font-medium">{item.name}</p>
        <p class="text-sm text-berry-fg-3">{formatClothesDate(item.date)}</p>
      </button>
    {/each}
  </div>
</Page>

{#if openIndex !== -1}
  {@const item = clothesData[openIndex]}
  <div
    use:focusTrap={() => ({})}
    class="fixed inset-0 z-[45] flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="clothes-detail-title"
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
        <h2 id="clothes-detail-title" class="text-lg font-semibold">{item.name}</h2>
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

      <div class="mt-4 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div class="text-center">
          <button type="button" class="block w-full cursor-zoom-in" onclick={() => openMainGallery(0)}>
            <img
              src={assetUrl(`/img/clothes/${item.date}/s1.webp`)}
              alt={item.name}
              class="mx-auto max-h-[60vh] rounded-lg border border-berry-border object-contain"
            />
          </button>
          <p class="mt-2 text-sm text-berry-fg-3">{m.clickToViewAll}</p>
        </div>

        <div>
          {#if item.tCount > 0}
            <div class="mb-4">
              <div class="mb-2 text-sm text-berry-fg-2">{m.expressions}</div>
              <div class="grid grid-cols-3 gap-2">
                {#each Array(item.tCount) as _, i (i)}
                  <button
                    type="button"
                    class="overflow-hidden rounded-md border border-berry-border"
                    onclick={() => openFaceGallery(i)}
                  >
                    <img
                      src={assetUrl(`/img/clothes/${item.date}/t${i + 1}.webp`)}
                      loading="lazy"
                      alt=""
                      class="aspect-square w-full cursor-zoom-in object-cover"
                    />
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <div class="rounded-lg border border-berry-border p-3 text-sm">
            <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5">
              <span class="text-right text-berry-text-emphasis">{m.debutDate}</span>
              <span>{formatClothesDate(item.date)}</span>
              <span class="text-right text-berry-text-emphasis">{m.designer}</span>
              <span>{item.designer}</span>
              <span class="text-right text-berry-text-emphasis">{m.modeler}</span>
              <span>{item.modeler}</span>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <a
                href="https://youtu.be/{item.link}"
                target="_blank"
                rel="noopener noreferrer"
                class="rounded-md border px-3 py-1.5 text-sm no-underline transition-opacity hover:opacity-80"
                style="border-color: #ff0000; color: #ff0000"
              >
                {m.revealStream}
              </a>
              {#if item.sideView}
                <button
                  type="button"
                  class="rounded-md border border-berry-border px-3 py-1.5 text-sm transition-colors hover:bg-berry-bg-3"
                  onclick={openSideGallery}
                >
                  📐 {m.turnaround}
                </button>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if lightbox}
  <Lightbox images={lightbox.images} startIndex={lightbox.index} onClose={closeLightbox} />
{/if}
