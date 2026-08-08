<script>
  // 表單頂部訊息條（錯誤 / 成功 / 提示）。色彩全部走 tokens。
  let { kind = 'error', children } = $props()

  const STYLES = {
    error:
      'border-color: var(--berry-subtle-border); background: var(--berry-subtle-bg); color: var(--berry-text-emphasis);',
    info: 'border-color: var(--berry-border); background: var(--berry-bg-3); color: var(--berry-fg-2);',
    success: 'border-color: var(--berry-green); background: transparent; color: var(--berry-fg);',
  }
</script>

<div
  class="mb-3 rounded-md border px-3 py-2 text-sm"
  style={STYLES[kind] ?? STYLES.info}
  role={kind === 'error' ? 'alert' : 'status'}
>
  {@render children?.()}
</div>
