<script>
  // 圖表卡片外殼：標題 + 口徑說明 + 內容（或空狀態）
  let { title, caption = '', empty = false, emptyText = '', children, aside } = $props()
</script>

<section class="rounded-xl border border-berry-border bg-berry-bg-3 p-4 sm:p-5">
  <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
    <h2 class="text-sm font-semibold">{title}</h2>
    {#if aside}
      <div class="text-sm text-berry-fg-3">{@render aside()}</div>
    {/if}
  </div>
  {#if caption}
    <p class="mt-1 text-sm text-berry-fg-3">{caption}</p>
  {/if}

  <div class="mt-4">
    {#if empty}
      <p class="py-10 text-center text-sm text-berry-fg-3">{emptyText}</p>
    {:else}
      {@render children?.()}
    {/if}
  </div>
</section>
