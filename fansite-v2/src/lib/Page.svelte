<script>
  // 頁面外殼：統一容器寬度、留白與標題排版（h2 下方 hairline，同現站裝飾語彙）
  //
  // wide：表格／圖表頁專用的加寬容器（1440px）。內容頁（首頁／個人資料／歷史／服裝）
  // 維持 max-w-6xl——長文行長超過 ~90 字元就難讀，加寬對它們是扣分。
  let { title, subtitle, children, toolbar, wide = false } = $props()
</script>

<main class="mx-auto {wide ? 'max-w-[1440px]' : 'max-w-6xl'} px-4 py-5 sm:py-6">
  <div class="flex flex-wrap items-end justify-between gap-2 border-b border-berry-border pb-2.5">
    <div>
      <h1 class="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
      {#if subtitle}
        <p class="mt-0.5 text-sm text-berry-fg-3">{subtitle}</p>
      {/if}
    </div>
    {#if toolbar}
      <div class="flex items-center gap-2">{@render toolbar()}</div>
    {/if}
  </div>

  <div class="mt-4">
    {@render children?.()}
  </div>
</main>
