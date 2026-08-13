<script>
  // Drawer 表單欄位外框：label ＋ 內容（children）＋ 欄位錯誤 / 提示
  let { label = '', error = '', hint = '', required = false, forId = undefined, children } = $props()
</script>

<div class="mb-3.5">
  {#if label}
    <label class="mb-1 block text-sm font-medium text-berry-fg-2" for={forId}>
      {label}{#if required}<span style="color: var(--berry-primary)"> *</span>{/if}
    </label>
  {/if}

  {@render children?.()}

  {#if error}
    <p class="mt-1 text-sm" style="color: var(--berry-primary)">{error}</p>
  {:else if hint}
    <p class="mt-1 text-sm text-berry-fg-3">{hint}</p>
  {/if}
</div>
