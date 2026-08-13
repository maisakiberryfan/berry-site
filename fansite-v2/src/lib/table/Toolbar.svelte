<script>
  // 列表頁唯一的一條工具列：左側搜尋/篩選、右側動作（＋新增、下載）
  let { children, actions } = $props()
</script>

<div class="mb-3 flex flex-wrap items-center gap-2">
  {@render children?.()}
  {#if actions}
    <div class="ml-auto flex items-center gap-2">{@render actions()}</div>
  {/if}
</div>
