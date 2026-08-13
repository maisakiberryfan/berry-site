<script>
  // 總覽統計卡（數字用 tabular-nums 對齊，載入中顯示 skeleton）
  let { label, value, hint = '', loading = false } = $props()
</script>

<div class="rounded-xl border border-berry-border bg-berry-bg-3 px-4 py-3.5">
  <!-- 標籤要能一眼讀懂數字的意思，所以字級／對比都比一般 caption 高一階 -->
  <div class="text-base font-semibold text-berry-fg-2">{label}</div>
  {#if loading}
    <div class="mt-1.5 h-8 w-20 animate-pulse rounded bg-berry-bg-2"></div>
  {:else}
    <div class="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight sm:text-3xl">{value}</div>
  {/if}
  {#if hint}
    <div class="mt-0.5 text-sm text-berry-fg-2">{hint}</div>
  {/if}
</div>
