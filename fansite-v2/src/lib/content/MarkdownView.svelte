<script>
  // 純渲染元件：把 markdown.js 解析好的 block 陣列畫成時間軸。
  // 不做任何字串拼接／innerHTML —— 全部走 Svelte 模板插值（自動跳脫），對抗 XSS。
  /** @type {{ blocks: Array<{type: string, [key: string]: any}> }} */
  let { blocks } = $props()
</script>

<div class="max-w-3xl">
  {#each blocks as block, i (i)}
    {#if block.type === 'year'}
      <h2
        id="year-{block.year}"
        class="mt-10 scroll-mt-24 border-b border-berry-border pb-2 text-lg font-semibold first:mt-0"
      >
        {block.year}
      </h2>
    {:else if block.type === 'item'}
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-l-2 border-berry-border py-1.5 pl-3">
        <span class="shrink-0 font-mono text-sm text-berry-fg-3">{block.date}</span>
        <span class="text-base">
          {#each block.segments as seg, j (j)}
            {#if seg.type === 'link'}
              <a href={seg.url} target="_blank" rel="noopener noreferrer" class="text-berry-link">{seg.text}</a>
            {:else}
              {seg.value}
            {/if}
          {/each}
        </span>
      </div>
    {:else}
      <p class="py-1 text-base text-berry-fg-2">{block.text}</p>
    {/if}
  {/each}
</div>
