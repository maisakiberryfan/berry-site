<script>
  // 查詢結果表：欄位由 SQL 結果動態決定，不預設 schema。
  //
  // 不用 DataTable.svelte 的理由：那支是為固定 schema 的列表頁做的（虛擬滾動 + 手機卡片 +
  // 編輯入口），SQL 結果則欄數不定、需橫向捲動、不需編輯。
  //
  // 版面：table-layout: fixed + colgroup 指定欄寬（依型別給不同寬度），欄總寬超過容器時
  // 橫向捲動；表頭 sticky（設在 th 上，thead sticky 各家瀏覽器支援不一）；
  // 分批渲染 200 列，避免 SELECT * 的 1.6 萬列一次塞爆 DOM。
  let { columns = [], rows = [], labels } = $props()

  const CHUNK = 200

  let shown = $state(CHUNK)

  // 換一次查詢就把「已顯示筆數」歸位
  $effect(() => {
    void rows
    shown = CHUNK
  })

  const visible = $derived(rows.slice(0, shown))
  const hasMore = $derived(rows.length > shown)

  const widthOf = (col) => (col.numeric ? 8 : col.time ? 11 : 15) // rem
  const totalWidth = $derived(columns.reduce((sum, c) => sum + widthOf(c), 0))

  function cellText(v) {
    if (v == null) return null
    return typeof v === 'string' ? v : String(v)
  }
</script>

<div
  class="overflow-auto rounded-lg border border-berry-border bg-berry-bg"
  style="max-height: min(65vh, 640px)"
>
  <table
    class="border-collapse text-sm"
    style="table-layout: fixed; width: max(100%, {totalWidth}rem)"
  >
    <colgroup>
      {#each columns as col (col.key)}
        <col style="width: {widthOf(col)}rem" />
      {/each}
    </colgroup>
    <thead>
      <tr>
        {#each columns as col (col.key)}
          <th
            class="sticky top-0 z-10 truncate border-b border-berry-border bg-berry-bg-2 px-3 py-2 font-medium text-berry-fg-2 {col.numeric
              ? 'text-right'
              : 'text-left'}"
            title="{col.key} · {col.type}"
          >
            {col.key}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each visible as row, i (i)}
        <tr class="border-b border-berry-border/60 hover:bg-berry-bg-3">
          {#each columns as col (col.key)}
            {@const text = cellText(row[col.key])}
            <td
              class="truncate px-3 py-1.5 {col.numeric ? 'text-right tabular-nums' : ''}"
              title={text ?? ''}
            >
              {#if text == null}
                <span class="text-berry-fg-3">—</span>
              {:else}
                {text}
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

{#if hasMore}
  <div class="mt-2 text-center">
    <button
      type="button"
      class="rounded-md border border-berry-border bg-berry-bg-3 px-3 py-1.5 text-sm transition-colors hover:bg-berry-bg-2"
      onclick={() => (shown = Math.min(rows.length, shown + CHUNK * 4))}
    >
      {labels.showMore(rows.length - shown)}
    </button>
  </div>
{/if}
