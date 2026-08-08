<script>
  // 極簡按鈕：所有色彩走 berry tokens，禁止硬編亮/暗前提色
  // variant: default / primary / ghost / danger    size: sm / md / icon
  let {
    variant = 'default',
    size = 'md',
    type = 'button',
    disabled = false,
    busy = false,
    title = undefined,
    ariaLabel = undefined,
    onclick = undefined,
    class: extra = '',
    children,
  } = $props()

  const BASE =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-sm leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-50'

  const SIZES = {
    sm: 'px-2.5 py-1.5 text-sm',
    md: 'px-3 py-1.5',
    icon: 'p-1.5',
  }

  const VARIANTS = {
    default: 'border-berry-border bg-berry-bg-3 text-berry-fg hover:bg-berry-bg-2',
    primary: 'border-transparent hover:brightness-110',
    ghost: 'border-transparent text-berry-fg-2 hover:bg-berry-bg-3 hover:text-berry-fg',
    danger: 'text-berry-text-emphasis hover:bg-berry-subtle-bg',
  }

  const styleFor = {
    primary: 'background: var(--berry-primary); color: #fff;',
    danger: 'border-color: var(--berry-subtle-border);',
  }
</script>

<button
  {type}
  {title}
  aria-label={ariaLabel}
  aria-busy={busy || undefined}
  disabled={disabled || busy}
  class="{BASE} {SIZES[size] ?? SIZES.md} {VARIANTS[variant] ?? VARIANTS.default} {extra}"
  style={styleFor[variant] ?? ''}
  {onclick}
>
  {#if busy}
    <svg class="size-3.5 animate-spin" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" opacity=".25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    </svg>
  {/if}
  {@render children?.()}
</button>
