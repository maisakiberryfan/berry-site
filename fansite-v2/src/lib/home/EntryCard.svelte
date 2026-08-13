<script>
  // 入口卡：筆數（載入中 skeleton）＋一句說明。站內連結由 router 的全域點擊攔截接手導航。
  import { formatNumber } from '../charts/format.js'

  /**
   * @type {{
   *   href: string, title: string, description?: string,
   *   count?: number | null, unit?: string, loading?: boolean,
   * }}
   */
  let { href, title, description = '', count = null, unit = '', loading = false } = $props()
</script>

<a
  {href}
  class="group flex flex-col rounded-xl border border-berry-border bg-berry-bg-3 p-3 no-underline transition-colors hover:bg-berry-bg-2"
  style="color: var(--berry-fg)"
>
  <div class="flex items-start justify-between gap-2">
    <span class="text-base font-medium">{title}</span>
    <span
      class="text-berry-fg-3 transition-transform group-hover:translate-x-0.5"
      aria-hidden="true">→</span
    >
  </div>

  {#if count != null || loading}
    <div class="mt-1.5 h-8">
      {#if count == null}
        <div class="h-7 w-16 animate-pulse rounded bg-berry-bg-2 group-hover:bg-berry-bg-3"></div>
      {:else}
        <span class="text-2xl font-semibold tabular-nums tracking-tight">{formatNumber(count)}</span>
        {#if unit}<span class="ml-1 text-sm text-berry-fg-3">{unit}</span>{/if}
      {/if}
    </div>
  {/if}

  {#if description}
    <p class="mt-auto pt-1.5 text-sm leading-snug text-berry-fg-3">{description}</p>
  {/if}
</a>
