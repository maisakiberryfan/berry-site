<script>
  // 統一輸入框樣式（單行 / 多行 / 數字 / datetime-local）
  // 注意：type 為動態值時 Svelte 不允許 bind:value，故手動處理 input 事件。
  let {
    value = $bindable(''),
    type = 'text',
    multiline = false,
    rows = 3,
    placeholder = '',
    disabled = false,
    readonly = false,
    invalid = false,
    id = undefined,
    min = undefined,
    max = undefined,
    step = undefined,
    maxlength = undefined,
    list = undefined,
    oninput = undefined,
    onkeydown = undefined,
    onblur = undefined,
    class: extra = '',
  } = $props()

  const BASE =
    'w-full rounded-md border bg-berry-bg-3 px-2.5 py-1.5 text-sm text-berry-fg outline-none transition-colors placeholder:text-berry-fg-3 focus:border-[var(--berry-primary)] disabled:opacity-60'

  function handleInput(e) {
    const el = e.currentTarget
    if (type === 'number') {
      value = el.value === '' ? '' : Number(el.value)
    } else {
      value = el.value
    }
    oninput?.(e)
  }
</script>

{#if multiline}
  <textarea
    {id}
    {rows}
    {placeholder}
    {disabled}
    {readonly}
    {maxlength}
    class="{BASE} resize-y {extra}"
    style={invalid ? 'border-color: var(--berry-primary)' : 'border-color: var(--berry-border)'}
    value={value ?? ''}
    oninput={handleInput}
    {onkeydown}
    {onblur}
  ></textarea>
{:else}
  <input
    {id}
    {type}
    {placeholder}
    {disabled}
    {readonly}
    {min}
    {max}
    {step}
    {maxlength}
    {list}
    class="{BASE} {extra}"
    style={invalid ? 'border-color: var(--berry-primary)' : 'border-color: var(--berry-border)'}
    value={value ?? ''}
    oninput={handleInput}
    {onkeydown}
    {onblur}
  />
{/if}
