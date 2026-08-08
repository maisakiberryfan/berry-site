<script>
  // 最新影片卡：/tb/{videoId}.jpg 縮圖（載不到時 fallback YouTube CDN 一次）、標題、本地時間
  import { formatDateTime } from './util.js'
  import { assetUrl } from '../../assets.js'

  // 使用者時區標記（原站慣例 +08:00 格式）；內聯計算避免依賴 table/utils
  const tzOff = -new Date().getTimezoneOffset()
  const tz = `${tzOff >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(tzOff) / 60)).padStart(2, '0')}:${String(Math.abs(tzOff) % 60).padStart(2, '0')}`

  /**
   * @type {{
   *   video: { videoId?: string, title?: string, time?: string, categories?: string[] } | null,
   *   loading?: boolean, label?: string, watchText?: string, emptyText?: string,
   * }}
   */
  let { video = null, loading = false, label = '', watchText = '', emptyText = '' } = $props()

  // 現站慣例：videoId 不像真的就不渲染卡片（避免組出壞連結）
  const id = $derived(String(video?.videoId ?? ''))
  const valid = $derived(/^[A-Za-z0-9_-]{9,11}$/.test(id))
  const url = $derived(valid ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : null)

  // fallback 記在「哪一支 id 已退回 YouTube CDN」而非布林旗標：
  // ① src 同步算得出來（不靠 $effect，避免首幀空 src 觸發假的 error）
  // ② id 一換自動失效，等於 once-per-video，不會無限迴圈
  let fallbackFor = $state(null)

  const src = $derived(
    !valid ? ''
    : fallbackFor === id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`
    : assetUrl(`/tb/${encodeURIComponent(id)}.jpg`),
  )

  function onImgError() {
    if (valid && fallbackFor !== id) fallbackFor = id
  }
</script>

{#if loading && !video}
  <div class="overflow-hidden rounded-xl border border-berry-border bg-berry-bg-3">
    <div class="aspect-video w-full animate-pulse bg-berry-bg-2"></div>
    <div class="space-y-2 p-3.5">
      <div class="h-3 w-28 animate-pulse rounded bg-berry-bg-2"></div>
      <div class="h-4 w-full animate-pulse rounded bg-berry-bg-2"></div>
      <div class="h-4 w-2/3 animate-pulse rounded bg-berry-bg-2"></div>
    </div>
  </div>
{:else if url}
  <a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    class="group block overflow-hidden rounded-xl border border-berry-border bg-berry-bg-3 no-underline transition-colors hover:border-berry-subtle-border"
  >
    <div class="aspect-video w-full overflow-hidden bg-berry-bg-2">
      <img
        {src}
        alt=""
        loading="lazy"
        decoding="async"
        onerror={onImgError}
        class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
      />
    </div>
    <div class="p-3.5">
      <div class="flex flex-wrap items-center gap-x-2 text-sm text-berry-fg-3">
        <span
          class="rounded-full px-2.5 py-1"
          style="background: var(--berry-subtle-bg); color: var(--berry-text-emphasis)"
        >
          {label}
        </span>
        <span class="tabular-nums">{formatDateTime(video?.time)}<span class="ml-1 opacity-75">({tz})</span></span>
      </div>

      <p class="mt-2 line-clamp-2 text-base font-medium" style="color: var(--berry-fg)">
        {video?.title ?? ''}
      </p>

      {#if Array.isArray(video?.categories) && video.categories.length}
        <div class="mt-2 flex flex-wrap gap-1.5">
          {#each video.categories as cat}
            <span
              class="rounded-full border border-berry-border px-2.5 py-1 text-sm text-berry-fg-3"
            >
              {cat}
            </span>
          {/each}
        </div>
      {/if}

      <span class="mt-2.5 inline-flex items-center gap-1 text-base" style="color: var(--berry-link)">
        {watchText}
        <span class="transition-transform group-hover:translate-x-0.5">→</span>
      </span>
    </div>
  </a>
{:else}
  <div
    class="flex min-h-40 items-center justify-center rounded-xl border border-berry-border bg-berry-bg-3 p-6 text-sm text-berry-fg-3"
  >
    {emptyText}
  </div>
{/if}
