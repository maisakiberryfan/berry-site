<script>
  // 衣裝頁：搬運自 fansite/pages/clothes.htm + assets/js/clothes.js
  // 資料照搬進 clothesData.js；modal 換成自寫 detail 面板 + 自寫 Lightbox（不裝 Fancybox）。
  //
  // 詳細頁走 **path**：`/clothes/20260611`（2026-08-14 由 `#20260611` 改制——path 才能
  // 讓 CloudFront／Worker 認出是哪一套衣裝、送出對應的 OG meta；hash 不會送到伺服器）。
  // token 格式沿用現站：`YYYYMMDD` / `YYYYMMDD-N`（直開第 N 張立繪）/ 舊版 `YYYYMMDD_s`。
  // 舊的 hash 連結（v2／v3 早期分享出去的）在 mount 時轉成對應 path，見 migrateLegacyHash。
  import { untrack } from 'svelte'
  import Page from '../lib/Page.svelte'
  import Lightbox from '../lib/content/Lightbox.svelte'
  import { t, getLang } from '../i18n.svelte.js'
  import { route, navigate } from '../router.svelte.js'
  import { clothesData, clothesDim, formatClothesDate } from './clothesData.js'
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

  /** 本頁的總覽路徑（詳細頁＝其下再加一段 token） */
  const BASE_PATH = '/clothes'

  /** 立繪圖片陣列（Lightbox 用）——`assetUrl` 只在元件端用得到，資料模組保持純資料 */
  function galleryImages(item, prefix, count) {
    return Array.from({ length: count }, (_, i) => ({
      src: assetUrl(`/img/clothes/${item.date}/${prefix}${i + 1}.webp`),
      alt: `${item.name} ${prefix}${i + 1}`,
    }))
  }

  function openDetail(idx) {
    openIndex = idx
    // 走 router 而非裸 history.replaceState：route.id 要跟著變，導覽列再點一次「衣裝」
    // （同頁 pushState 回總覽路徑）面板才關得掉。
    // replace 而非 push：沿用改制前的行為——開著面板按上一頁是離開本頁，不是關面板。
    // 保留 query string：裸接 BASE_PATH 會把 ?lang= 之類的參數一併吃掉
    navigate(`${BASE_PATH}/${clothesData[idx].date}${location.search}`, {
      replace: true,
      scroll: false,
    })
  }

  function closeDetail() {
    openIndex = -1
    if (route.id) navigate(`${BASE_PATH}${location.search}`, { replace: true, scroll: false })
  }

  function openMainGallery(startIndex = 0) {
    const item = clothesData[openIndex]
    if (!item) return
    lightbox = { images: galleryImages(item, 's', item.count), index: startIndex }
  }

  function openFaceGallery(startIndex) {
    const item = clothesData[openIndex]
    if (!item) return
    lightbox = { images: galleryImages(item, 't', item.tCount), index: startIndex }
  }

  function openSideGallery() {
    const item = clothesData[openIndex]
    if (!item?.sideView) return
    lightbox = { images: galleryImages(item, 'c', item.sideView), index: 0 }
  }

  function closeLightbox() {
    lightbox = null
  }

  // 路徑直達：/clothes/YYYYMMDD 開詳細面板；/clothes/YYYYMMDD-N 直開 Lightbox 第 N 張立繪；
  // 舊版 YYYYMMDD_s（四面圖 gallery 舊連結）→ 開詳細面板即可（四面圖入口已在面板內）
  //
  // ⚠️ 本函式由 $effect 呼叫，讀 openIndex 一律走 untrack：把它收成依賴的話，
  //    開面板這個動作本身就會讓 effect 再跑一次（自我觸發），Lightbox 也會被重開。
  /** 上一次套用過的 id（非 $state：只給本函式比對用，不該引起重繪） */
  let appliedId = ''

  function applyRouteId(raw) {
    const id = String(raw ?? '')
    if (!id) {
      appliedId = ''
      openIndex = -1
      return
    }
    const parts = id.split('-')
    const date = parts[0].replace(/_s$/, '')
    const idx = clothesData.findIndex((e) => e.date === date)
    // 認不得的 id：當作沒開面板（顯示總覽）。刻意不轉 NotFound——資料調整過的舊連結
    // 軟著陸比丟 404 頁友善。改制前的 hash 版在這裡是「不動作」（怕動到別人的錨點），
    // path 沒有這個顧慮：`/clothes/xxx` 就是在講本頁的某一套，認不得就該收掉面板——
    // 不然「開著面板時導到未知 id」會留著上一套的內容，與直接開該網址的結果不一致
    if (idx === -1) {
      appliedId = ''
      openIndex = -1
      return
    }

    const prevId = appliedId
    appliedId = id
    if (untrack(() => openIndex) !== idx) openIndex = idx

    // 只在 id 真的變成這個值的當下開 Lightbox——effect 重跑不該把使用者關掉的圖再打開
    if (parts[1] && !parts[0].endsWith('_s') && prevId !== id) {
      const item = clothesData[idx]
      const imgIndex = Math.max(0, parseInt(parts[1], 10) - 1)
      lightbox = { images: galleryImages(item, 's', item.count), index: Math.min(imgIndex, item.count - 1) }
    }
  }

  // 面板狀態跟著 router 的動態段走：導覽列點同頁（pushState 回總覽路徑）不發任何
  // hashchange，只有 route.id 會變，靠這個 effect 收斂（與 Discography 同一套機制）
  $effect(() => {
    applyRouteId(route.id)
  })

  // 舊 hash 連結相容：`/clothes#20260611`（v2／v3 早期分享出去的網址）→ replace 成
  // `/clothes/20260611`。hashchange 也掛著：手動在網址列改 hash 不會重新載入頁面，
  // 沒有這條的話舊格式在同一分頁內就完全沒反應。
  //   ・只認「本頁的 token 形狀」（8 位數日期開頭），其餘 hash 可能是別人的錨點，不碰
  //   ・已經在詳細頁時也照樣清掉 hash（`/clothes/20260611#20260611` → 前者）
  function migrateLegacyHash() {
    const hash = String(location.hash || '').replace(/^#/, '')
    if (!/^\d{8}(_s)?(-\d+)?$/.test(hash)) return
    navigate(`${BASE_PATH}/${hash}${location.search}`, { replace: true, scroll: false })
  }

  $effect(() => {
    migrateLegacyHash()
    window.addEventListener('hashchange', migrateLegacyHash)
    return () => window.removeEventListener('hashchange', migrateLegacyHash)
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
        <p class="text-sm text-berry-fg-3">{formatClothesDate(item.date, getLang())}</p>
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
              <span>{formatClothesDate(item.date, getLang())}</span>
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
