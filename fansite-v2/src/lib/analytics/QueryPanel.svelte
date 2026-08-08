<script>
  // 資料查詢面板
  //
  // 建構器模式：欄位／條件／分組／排序全部用選的 → builder.js 產生 SQL（值以 ? 綁定）
  //             → sql.js 執行。使用者不必會 SQL，也不需要 AI 代寫。
  // 進階模式  ：SQL 編輯器 + 範例 + 欄位參考（給會寫的人），同一個引擎。
  // 結果      ：動態欄位表格、筆數與耗時、CSV / JSON 下載
  //
  // 資料一律來自瀏覽器裡已有的 store 快取（dataset.js 攤平成寬表），
  // 不打任何查詢用 API。
  import { tick } from 'svelte'
  import { getLang } from '../../i18n.svelte.js'
  import { exportRows } from '../table/utils.js'
  import {
    songlist,
    streamlist,
    setlist,
    setlistJoined,
    songIndex,
    loadAll,
  } from '../../api/store.svelte.js'
  import { exampleQueries, COLUMN_REFERENCE, TABLE_NAME } from './queries.js'
  import {
    FIELDS,
    AGGREGATES,
    NUMERIC_FIELDS,
    QUICK_TEMPLATES,
    DEFAULT_LIMIT,
    buildQuery,
    defaultState,
    emptyFilter,
    fieldKind,
    operatorsFor,
    operatorArity,
    coerceOperator,
    aggAlias,
  } from './builder.js'
  import { buildDataset } from './dataset.js'
  import { runQuery, engineReady } from './engine.js'
  import ResultTable from './ResultTable.svelte'

  /* ---------- 頁內三語字典 ---------- */
  const msgs = {
    zh: {
      panelTitle: '資料查詢',
      modeBuilder: '查詢建構器',
      modeAdvanced: '進階 SQL',
      intro: '選欄位、加條件就能查；下方會即時顯示組出來的 SQL。',
      quick: '快速範本',
      columns: '顯示欄位',
      columnsAll: '全選',
      columnsNone: '清空',
      columnsEmpty: '未選＝顯示全部欄位',
      columnsGroupHint: '分組統計中，將輸出的欄位',
      filters: '篩選條件',
      filtersHint: '多條件同時成立（AND）',
      addFilter: '新增條件',
      removeFilter: '移除條件',
      noFilters: '沒有條件＝查全部',
      skipped: (n) => `${n} 個條件還沒填值，暫時沒套用`,
      group: '分組統計',
      groupField: '分組欄位',
      agg: '統計方式',
      aggField: '統計欄位',
      sort: '排序',
      sortNone: '不排序',
      dirDesc: '遞減（大→小）',
      dirAsc: '遞增（小→大）',
      limit: '筆數上限',
      sqlPreview: '組出來的 SQL',
      run: '執行查詢',
      copyToAdvanced: '在進階模式編輯',
      op: {
        eq: '等於',
        contains: '包含',
        startsWith: '開頭為',
        gt: '大於',
        lt: '小於',
        between: '介於',
        notEmpty: '不為空',
      },
      opDate: {
        eq: '就在這天',
        gt: '這天（含）之後',
        lt: '這天（含）之前',
        between: '介於',
        notEmpty: '有時間',
      },
      aggLabel: {
        count: '筆數',
        countDistinct: '去重計數',
        avg: '平均',
        sum: '總和',
        max: '最大值',
        min: '最小值',
      },
      valuePlaceholder: '值',
      valueTo: '到',
      runSql: '執行 SQL',
      sqlLabel: 'SQL 查詢',
      sqlDocs: 'SQL 可用語法',
      sqlPlaceholder: `SELECT * FROM ${TABLE_NAME} WHERE ...`,
      examples: '範例：',
      columnsToggle: '可用欄位',
      columnsHint: '點欄位名可插入編輯器',
      exampleLabel: '範例：',
      stage: {
        engine: '載入查詢引擎中…',
        data: '建立資料表中…',
        query: '查詢執行中…',
      },
      resultInfo: (n, ms) => `${n.toLocaleString()} 筆結果 · ${ms} ms`,
      showMore: (n) => `載入更多（剩 ${n.toLocaleString()} 筆）`,
      empty: '查詢成功，但沒有符合條件的資料',
      idle: '設定好條件後按「執行查詢」，結果會顯示在這裡',
      errorTitle: '查詢失敗',
      csv: '下載 CSV',
      json: '下載 JSON',
      dataInfo: (n) => `${n.toLocaleString()} 筆`,
      dataSyncing: (n) => `${n.toLocaleString()} 筆 · 同步中…`,
    },
    en: {
      panelTitle: 'Data query',
      modeBuilder: 'Query builder',
      modeAdvanced: 'Advanced SQL',
      intro: 'Pick columns, add conditions — the matching SQL is shown below as you go.',
      quick: 'Quick starts',
      columns: 'Columns to show',
      columnsAll: 'All',
      columnsNone: 'Clear',
      columnsEmpty: 'Nothing selected = show every column',
      columnsGroupHint: 'Output columns while grouping',
      filters: 'Filters',
      filtersHint: 'All conditions must match (AND)',
      addFilter: 'Add condition',
      removeFilter: 'Remove condition',
      noFilters: 'No conditions = everything',
      skipped: (n) => `${n} condition(s) have no value yet and are not applied`,
      group: 'Group & summarise',
      groupField: 'Group by',
      agg: 'Statistic',
      aggField: 'Of column',
      sort: 'Sort',
      sortNone: 'No sorting',
      dirDesc: 'Descending',
      dirAsc: 'Ascending',
      limit: 'Row limit',
      sqlPreview: 'Generated SQL',
      run: 'Run query',
      copyToAdvanced: 'Edit as SQL',
      op: {
        eq: 'is',
        contains: 'contains',
        startsWith: 'starts with',
        gt: 'greater than',
        lt: 'less than',
        between: 'between',
        notEmpty: 'is not empty',
      },
      opDate: {
        eq: 'on this day',
        gt: 'on or after',
        lt: 'on or before',
        between: 'between',
        notEmpty: 'has a time',
      },
      aggLabel: {
        count: 'Count',
        countDistinct: 'Distinct count',
        avg: 'Average',
        sum: 'Sum',
        max: 'Maximum',
        min: 'Minimum',
      },
      valuePlaceholder: 'value',
      valueTo: 'to',
      runSql: 'Execute SQL',
      sqlLabel: 'SQL query',
      sqlDocs: 'SQL syntax',
      sqlPlaceholder: `SELECT * FROM ${TABLE_NAME} WHERE ...`,
      examples: 'Examples:',
      columnsToggle: 'Available columns',
      columnsHint: 'Click a column name to insert it',
      exampleLabel: 'Example:',
      stage: {
        engine: 'Loading query engine…',
        data: 'Building the table…',
        query: 'Running query…',
      },
      resultInfo: (n, ms) => `${n.toLocaleString()} rows · ${ms} ms`,
      showMore: (n) => `Show more (${n.toLocaleString()} left)`,
      empty: 'Query succeeded, but returned no rows',
      idle: 'Set up your query and hit Run — results appear here',
      errorTitle: 'Query failed',
      csv: 'Download CSV',
      json: 'Download JSON',
      dataInfo: (n) => `${n.toLocaleString()} rows`,
      dataSyncing: (n) => `${n.toLocaleString()} rows · syncing…`,
    },
    ja: {
      panelTitle: 'データ検索',
      modeBuilder: 'クエリビルダー',
      modeAdvanced: '上級 SQL',
      intro: '項目を選んで条件を足すだけ。生成される SQL は下にリアルタイム表示されます。',
      quick: 'クイックテンプレート',
      columns: '表示する項目',
      columnsAll: 'すべて',
      columnsNone: 'クリア',
      columnsEmpty: '未選択＝全項目を表示',
      columnsGroupHint: 'グループ集計中の出力項目',
      filters: '絞り込み条件',
      filtersHint: 'すべての条件を満たすもの（AND）',
      addFilter: '条件を追加',
      removeFilter: '条件を削除',
      noFilters: '条件なし＝全件',
      skipped: (n) => `${n} 件の条件は値が未入力のため未適用です`,
      group: 'グループ集計',
      groupField: 'グループ項目',
      agg: '集計方法',
      aggField: '対象項目',
      sort: '並び替え',
      sortNone: '並び替えなし',
      dirDesc: '降順（大→小）',
      dirAsc: '昇順（小→大）',
      limit: '最大件数',
      sqlPreview: '生成された SQL',
      run: 'クエリ実行',
      copyToAdvanced: 'SQL で編集',
      op: {
        eq: 'が次と一致',
        contains: 'を含む',
        startsWith: 'で始まる',
        gt: 'が次より大きい',
        lt: 'が次より小さい',
        between: 'が次の範囲',
        notEmpty: 'が空でない',
      },
      opDate: {
        eq: 'がこの日',
        gt: 'がこの日以降',
        lt: 'がこの日以前',
        between: 'が次の範囲',
        notEmpty: 'に時刻がある',
      },
      aggLabel: {
        count: '件数',
        countDistinct: 'ユニーク数',
        avg: '平均',
        sum: '合計',
        max: '最大',
        min: '最小',
      },
      valuePlaceholder: '値',
      valueTo: '〜',
      runSql: 'SQL 実行',
      sqlLabel: 'SQL クエリ',
      sqlDocs: 'SQL 構文',
      sqlPlaceholder: `SELECT * FROM ${TABLE_NAME} WHERE ...`,
      examples: '例：',
      columnsToggle: '利用可能なカラム',
      columnsHint: 'カラム名をクリックで挿入',
      exampleLabel: '例：',
      stage: {
        engine: 'クエリエンジンを読み込み中…',
        data: 'テーブルを構築中…',
        query: 'クエリを実行中…',
      },
      resultInfo: (n, ms) => `${n.toLocaleString()} 件 · ${ms} ms`,
      showMore: (n) => `さらに表示（残り ${n.toLocaleString()} 件）`,
      empty: 'クエリは成功しましたが、該当データはありません',
      idle: '条件を設定して「クエリ実行」を押すと、ここに結果が出ます',
      errorTitle: 'クエリ失敗',
      csv: 'CSV をダウンロード',
      json: 'JSON をダウンロード',
      dataInfo: (n) => `${n.toLocaleString()} 件`,
      dataSyncing: (n) => `${n.toLocaleString()} 件 · 同期中…`,
    },
  }

  const lang = $derived(getLang())
  const m = $derived(msgs[lang] ?? msgs.zh)
  const L = (obj) => obj?.[lang] ?? obj?.zh ?? ''

  /* ---------- 欄位顯示名 ---------- */
  const COL_MAP = new Map(COLUMN_REFERENCE.map((c) => [c.name, c]))
  const fieldLabel = (key) => {
    const c = COL_MAP.get(key)
    return c ? L(c.short ?? c.desc) : key
  }

  /* ---------- 狀態 ---------- */
  let filterUid = 0

  /** 每條篩選給一個穩定 key，{#each} 才不會在增刪時錯位 */
  function withIds(state) {
    return { ...state, filters: state.filters.map((f) => ({ ...f, _id: ++filterUid })) }
  }

  let mode = $state('builder')
  let builder = $state(withIds(defaultState()))

  let sql = $state('')
  let sqlEl = $state(null)

  let running = $state(false)
  let stage = $state(null)
  let engineLoaded = $state(engineReady())
  let error = $state(null)
  let result = $state(null)
  let ran = $state(false)
  let showColumns = $state(false)

  const examples = exampleQueries()

  /* ---------- 資料集（瀏覽器內既有的快取，攤平成寬表） ----------
     buildDataset 以輸入 identity memo，因此 store 沒動時陣列 identity 不變，
     sql.js 那邊也就不會重建表；store 背景校正完成後 identity 一變即自動重建。 */
  const dataset = $derived(buildDataset(setlistJoined.rows, songIndex.map))
  const dataSynced = $derived(setlist.synced && streamlist.synced && songlist.synced)

  loadAll()

  /** 面板可能比資料先就緒——執行前確保三張表都載過 */
  async function readyDataset() {
    if (!dataset.length) {
      stage = 'data'
      await loadAll()
    }
    return dataset
  }

  /* ---------- 建構器操作 ---------- */

  const built = $derived(buildQuery(builder))

  function addFilter() {
    builder.filters.push({ ...emptyFilter('songName'), _id: ++filterUid })
  }

  function removeFilter(i) {
    builder.filters.splice(i, 1)
  }

  /** 換欄位可能讓原運算子失效（例如文字→數字），順手校正並清值 */
  function changeFilterField(i, key) {
    const f = builder.filters[i]
    f.field = key
    f.op = coerceOperator(f.op, fieldKind(key) ?? 'text')
    f.value = ''
    f.value2 = ''
  }

  function changeFilterOp(i, op) {
    const f = builder.filters[i]
    f.op = op
    if (operatorArity(op) === 0) {
      f.value = ''
      f.value2 = ''
    }
  }

  function toggleColumn(key, on) {
    const cols = builder.columns
    if (on) {
      if (!cols.includes(key)) cols.push(key)
    } else {
      const i = cols.indexOf(key)
      if (i >= 0) cols.splice(i, 1)
    }
  }

  function toggleGroup(on) {
    builder.group.enabled = on
    // 分組後預設看統計值排序；關掉時退回時間排序
    builder.sort = on
      ? { field: aggAlias(builder.group), dir: 'desc' }
      : { field: 'time', dir: 'desc' }
  }

  function changeAgg(next) {
    builder.group.agg = next
    const spec = AGGREGATES.find((a) => a.id === next)
    if (spec?.numericOnly && !NUMERIC_FIELDS.includes(builder.group.aggField)) {
      builder.group.aggField = 'durationSec'
    }
    builder.sort = { field: aggAlias(builder.group), dir: builder.sort.dir }
  }

  /** 分組欄位換了：原本照分組欄排序的話跟著換，免得排序下拉指到不存在的選項 */
  function changeGroupField(next) {
    if (builder.sort.field === builder.group.field) builder.sort.field = next
    builder.group.field = next
  }

  function applyTemplate(tpl) {
    builder = withIds(tpl.state())
    mode = 'builder'
  }

  const groupAgg = $derived(AGGREGATES.find((a) => a.id === builder.group.agg) ?? AGGREGATES[0])
  const aggFieldOptions = $derived(
    groupAgg.numericOnly ? FIELDS.filter((f) => f.kind === 'number') : FIELDS,
  )
  const sortOptions = $derived(
    builder.group.enabled
      ? [
          { key: builder.group.field, label: fieldLabel(builder.group.field) },
          { key: aggAlias(builder.group), label: m.aggLabel[builder.group.agg] },
        ]
      : FIELDS.map((f) => ({ key: f.key, label: fieldLabel(f.key) })),
  )

  function opLabel(field, op) {
    const dict = fieldKind(field) === 'date' ? m.opDate : m.op
    return dict[op] ?? m.op[op] ?? op
  }

  function inputType(field) {
    const kind = fieldKind(field)
    return kind === 'date' ? 'date' : kind === 'number' ? 'number' : 'text'
  }

  /* ---------- 執行 ---------- */

  async function execute(text, params = null) {
    const q = String(text ?? '').trim()
    if (!q || running) return
    running = true
    error = null
    try {
      const rows = await readyDataset()
      result = await runQuery(q, rows, (s) => (stage = s), params)
      engineLoaded = true
    } catch (err) {
      result = null
      error = String(err?.message ?? err)
    } finally {
      ran = true
      running = false
      stage = null
    }
  }

  function runBuilder() {
    execute(built.sql, built.params)
  }

  /** 建構器 → 進階模式：帶值內嵌的版本，貼過去可以直接改直接跑 */
  async function toAdvanced() {
    sql = built.preview
    mode = 'advanced'
    await tick()
    sqlEl?.focus()
  }

  function setMode(next) {
    mode = next
    if (next === 'advanced' && !sql.trim()) sql = built.preview
  }

  async function useExample(text) {
    mode = 'advanced'
    sql = text
    await tick()
    sqlEl?.focus()
  }

  async function insertAtCursor(text) {
    const el = sqlEl
    if (!el) {
      sql += text
      return
    }
    const s = el.selectionStart ?? sql.length
    const e = el.selectionEnd ?? sql.length
    sql = sql.slice(0, s) + text + sql.slice(e)
    await tick()
    el.focus()
    const pos = s + text.length
    el.setSelectionRange(pos, pos)
  }

  /* ---------- 匯出 ---------- */

  function download(format) {
    if (!result?.rows.length) return
    const cols = result.columns.map((c) => ({ key: c.key, label: c.key }))
    exportRows(result.rows, cols, 'berry-query', format)
  }

  /* ---------- 樣式常數 ---------- */
  const BTN =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-berry-border bg-berry-bg-3 px-3 py-1.5 text-sm leading-none transition-colors hover:bg-berry-bg-2 disabled:cursor-not-allowed disabled:opacity-50'
  const FIELD =
    'w-full rounded-md border border-berry-border bg-berry-bg px-3 py-1.5 text-sm text-berry-fg outline-none focus:border-berry-primary'
  const SUBCARD = 'rounded-lg border border-berry-border bg-berry-bg p-3'
  const LEGEND = 'mb-2 block text-sm font-medium text-berry-fg-2'
</script>

<section class="rounded-xl border border-berry-border bg-berry-bg-3 p-4 sm:p-5" aria-label={m.panelTitle}>
  <!-- 模式切換 ＋ 資料筆數 -->
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="inline-flex rounded-lg border border-berry-border bg-berry-bg p-0.5">
      {#each [{ id: 'builder', label: m.modeBuilder }, { id: 'advanced', label: m.modeAdvanced }] as tab (tab.id)}
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm transition-colors {mode === tab.id
            ? 'text-white'
            : 'text-berry-fg-2 hover:text-berry-fg'}"
          style={mode === tab.id ? 'background: var(--berry-primary)' : ''}
          aria-pressed={mode === tab.id}
          onclick={() => setMode(tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>
    {#if dataset.length}
      <p class="text-sm text-berry-fg-3">
        {dataSynced ? m.dataInfo(dataset.length) : m.dataSyncing(dataset.length)}
      </p>
    {/if}
  </div>

  {#if mode === 'builder'}
    <!-- ===================== 建構器 ===================== -->
    <p class="mt-3 text-sm text-berry-fg-2">{m.intro}</p>

    <!-- 快速範本 -->
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <span class="text-sm text-berry-fg-3">{m.quick}</span>
      {#each QUICK_TEMPLATES as tpl (tpl.id)}
        <button type="button" class="{BTN} rounded-full px-3 py-1" onclick={() => applyTemplate(tpl)}>
          {L(tpl.label)}
        </button>
      {/each}
    </div>

    <div class="mt-4 space-y-3">
      <!-- 顯示欄位 -->
      <div class={SUBCARD} role="group" aria-label={m.columns}>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span class="text-sm font-medium text-berry-fg-2">{m.columns}</span>
          {#if !builder.group.enabled}
            <div class="flex gap-2">
              <button
                type="button"
                class="{BTN} px-2 py-1"
                onclick={() => (builder.columns = FIELDS.map((f) => f.key))}
              >
                {m.columnsAll}
              </button>
              <button type="button" class="{BTN} px-2 py-1" onclick={() => (builder.columns = [])}>
                {m.columnsNone}
              </button>
            </div>
          {/if}
        </div>

        {#if builder.group.enabled}
          <!-- 分組時具體列出實際輸出欄位（抽象說明不易懂——回饋 2026-08-08） -->
          <p class="text-sm text-berry-fg-2">
            {m.columnsGroupHint}：
            <span class="font-medium text-berry-fg">{fieldLabel(builder.group.field)}</span>
            <span class="mx-1 text-berry-fg-3">＋</span>
            <span class="font-medium text-berry-fg">{m.aggLabel[builder.group.agg]}{builder.group.agg !== 'count' && builder.group.aggField ? `（${fieldLabel(builder.group.aggField)}）` : ''}</span>
          </p>
        {:else}
          <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-4">
            {#each FIELDS as f (f.key)}
              <label class="flex items-center gap-2 text-sm" title={f.key}>
                <input
                  type="checkbox"
                  class="accent-berry-primary"
                  checked={builder.columns.includes(f.key)}
                  onchange={(e) => toggleColumn(f.key, e.currentTarget.checked)}
                />
                <span class="truncate">{fieldLabel(f.key)}</span>
              </label>
            {/each}
          </div>
          {#if !builder.columns.length}
            <p class="mt-2 text-sm text-berry-fg-3">{m.columnsEmpty}</p>
          {/if}
        {/if}
      </div>

      <!-- 篩選條件 -->
      <div class={SUBCARD} role="group" aria-label={m.filters}>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span class="text-sm font-medium text-berry-fg-2">{m.filters}</span>
          <span class="text-sm text-berry-fg-3">{m.filtersHint}</span>
        </div>

        {#if !builder.filters.length}
          <p class="mb-2 text-sm text-berry-fg-3">{m.noFilters}</p>
        {/if}

        <div class="space-y-2">
          {#each builder.filters as f, i (f._id)}
            {@const arity = operatorArity(f.op)}
            <div class="grid gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,10rem)_minmax(0,1fr)_auto]">
              <select
                class={FIELD}
                aria-label={m.filters}
                value={f.field}
                onchange={(e) => changeFilterField(i, e.currentTarget.value)}
              >
                {#each FIELDS as opt (opt.key)}
                  <option value={opt.key}>{fieldLabel(opt.key)}</option>
                {/each}
              </select>

              <select
                class={FIELD}
                aria-label={m.filters}
                value={f.op}
                onchange={(e) => changeFilterOp(i, e.currentTarget.value)}
              >
                {#each operatorsFor(fieldKind(f.field) ?? 'text') as op (op.id)}
                  <option value={op.id}>{opLabel(f.field, op.id)}</option>
                {/each}
              </select>

              {#if arity === 0}
                <span class="hidden sm:block"></span>
              {:else if arity === 1}
                <input
                  type={inputType(f.field)}
                  class={FIELD}
                  placeholder={m.valuePlaceholder}
                  bind:value={f.value}
                />
              {:else}
                <div class="flex items-center gap-2">
                  <input
                    type={inputType(f.field)}
                    class={FIELD}
                    placeholder={m.valuePlaceholder}
                    bind:value={f.value}
                  />
                  <span class="text-sm text-berry-fg-3">{m.valueTo}</span>
                  <input
                    type={inputType(f.field)}
                    class={FIELD}
                    placeholder={m.valuePlaceholder}
                    bind:value={f.value2}
                  />
                </div>
              {/if}

              <button
                type="button"
                class="{BTN} px-2 py-1"
                aria-label={m.removeFilter}
                title={m.removeFilter}
                onclick={() => removeFilter(i)}
              >
                ✕
              </button>
            </div>
          {/each}
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" class="{BTN} px-2 py-1" onclick={addFilter}>＋ {m.addFilter}</button>
          {#if built.skipped.length}
            <span class="text-sm" style="color: var(--berry-text-emphasis)">
              {m.skipped(built.skipped.length)}
            </span>
          {/if}
        </div>
      </div>

      <!-- 分組統計 -->
      <div class={SUBCARD}>
        <label class="flex items-center gap-2 text-sm font-medium text-berry-fg-2">
          <input
            type="checkbox"
            class="accent-berry-primary"
            checked={builder.group.enabled}
            onchange={(e) => toggleGroup(e.currentTarget.checked)}
          />
          {m.group}
        </label>

        {#if builder.group.enabled}
          <div class="mt-2 grid gap-2 sm:grid-cols-3">
            <label class="block text-sm">
              <span class="mb-1 block text-berry-fg-3">{m.groupField}</span>
              <select
                class={FIELD}
                value={builder.group.field}
                onchange={(e) => changeGroupField(e.currentTarget.value)}
              >
                {#each FIELDS as opt (opt.key)}
                  <option value={opt.key}>{fieldLabel(opt.key)}</option>
                {/each}
              </select>
            </label>

            <label class="block text-sm">
              <span class="mb-1 block text-berry-fg-3">{m.agg}</span>
              <select
                class={FIELD}
                value={builder.group.agg}
                onchange={(e) => changeAgg(e.currentTarget.value)}
              >
                {#each AGGREGATES as agg (agg.id)}
                  <option value={agg.id}>{m.aggLabel[agg.id]}</option>
                {/each}
              </select>
            </label>

            {#if groupAgg.needsField}
              <label class="block text-sm">
                <span class="mb-1 block text-berry-fg-3">{m.aggField}</span>
                <select class={FIELD} bind:value={builder.group.aggField}>
                  {#each aggFieldOptions as opt (opt.key)}
                    <option value={opt.key}>{fieldLabel(opt.key)}</option>
                  {/each}
                </select>
              </label>
            {/if}
          </div>
        {/if}
      </div>

      <!-- 排序 ＋ 筆數上限 -->
      <div class={SUBCARD} role="group" aria-label={m.sort}>
        <span class={LEGEND}>{m.sort}</span>
        <div class="grid gap-2 sm:grid-cols-3">
          <select class={FIELD} aria-label={m.sort} bind:value={builder.sort.field}>
            {#if !builder.group.enabled}
              <option value="">{m.sortNone}</option>
            {/if}
            {#each sortOptions as opt (opt.key)}
              <option value={opt.key}>{opt.label}</option>
            {/each}
          </select>
          <select class={FIELD} aria-label={m.sort} bind:value={builder.sort.dir}>
            <option value="desc">{m.dirDesc}</option>
            <option value="asc">{m.dirAsc}</option>
          </select>
          <label class="flex items-center gap-2 text-sm text-berry-fg-3">
            {m.limit}
            <input
              type="number"
              min="1"
              max="20000"
              class="{FIELD} max-w-28"
              value={builder.limit}
              onchange={(e) => (builder.limit = e.currentTarget.value || DEFAULT_LIMIT)}
            />
          </label>
        </div>
      </div>

      <!-- SQL 預覽 -->
      <div class={SUBCARD}>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span class="text-sm font-medium text-berry-fg-2">{m.sqlPreview}</span>
          <button type="button" class="{BTN} px-2 py-1" onclick={toAdvanced}>
            {m.copyToAdvanced}
          </button>
        </div>
        <pre
          class="overflow-x-auto rounded-md bg-berry-bg-2 p-3 font-mono text-xs leading-relaxed text-berry-fg-2">{built.preview}</pre>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="{BTN} border-transparent text-white hover:brightness-110"
          style="background: var(--berry-primary)"
          disabled={running}
          onclick={runBuilder}
        >
          {running ? (m.stage[stage] ?? m.stage.query) : m.run}
        </button>
        {#if !engineLoaded}
        {/if}
      </div>
    </div>
  {:else}
    <!-- ===================== 進階 SQL ===================== -->
    <div class="mt-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <label class="text-sm text-berry-fg-2" for="qp-sql">{m.sqlLabel}</label>
        <a href="https://www.sqlite.org/lang_select.html" target="_blank" rel="noopener noreferrer" class="text-sm">
          {m.sqlDocs}
        </a>
      </div>

      <textarea
        id="qp-sql"
        bind:this={sqlEl}
        bind:value={sql}
        rows="6"
        spellcheck="false"
        class="{FIELD} resize-y font-mono"
        placeholder={m.sqlPlaceholder}
      ></textarea>

      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm text-berry-fg-3">{m.examples}</span>
        {#each examples as ex (ex.id)}
          <button type="button" class="{BTN} px-2 py-1" onclick={() => useExample(ex.sql)}>
            {L(ex.label)}
          </button>
        {/each}
        <button
          type="button"
          class="{BTN} px-2 py-1"
          aria-expanded={showColumns}
          onclick={() => (showColumns = !showColumns)}
        >
          {showColumns ? '▾' : '▸'} {m.columnsToggle}
        </button>
      </div>

      {#if showColumns}
        <div class={SUBCARD}>
          <p class="mb-2 text-sm text-berry-fg-3">{m.columnsHint}</p>
          <ul class="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {#each COLUMN_REFERENCE as col (col.name)}
              <li class="text-sm">
                <button
                  type="button"
                  class="font-mono text-berry-link hover:text-berry-link-hover"
                  onclick={() => insertAtCursor(col.name)}
                >
                  {col.name}
                </button>
                <span class="text-berry-fg-3"> — {L(col.desc)} ({col.type})</span>
                {#if col.example}
                  <span class="ml-1 font-mono text-berry-fg-3">{m.exampleLabel}{col.example}</span>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="{BTN} border-transparent text-white hover:brightness-110"
          style="background: var(--berry-primary)"
          disabled={running || !sql.trim()}
          onclick={() => execute(sql)}
        >
          {running ? (m.stage[stage] ?? m.stage.query) : m.runSql}
        </button>
        {#if !engineLoaded}
        {/if}
      </div>
    </div>
  {/if}

  <!-- ===================== 結果 ===================== -->
  <div class="mt-5 border-t border-berry-border pt-4">
    {#if error}
      <div
        class="rounded-lg border px-3 py-2"
        style="border-color: var(--berry-subtle-border); background: var(--berry-subtle-bg)"
      >
        <p class="text-sm font-medium" style="color: var(--berry-text-emphasis)">{m.errorTitle}</p>
        <pre class="mt-1 overflow-x-auto whitespace-pre-wrap text-sm text-berry-fg-2">{error}</pre>
      </div>
    {:else if result}
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm text-berry-fg-2">
          {m.resultInfo(result.rows.length, result.ms)}
        </p>
        {#if result.rows.length}
          <div class="flex gap-2">
            <button type="button" class="{BTN} px-2 py-1" onclick={() => download('csv')}>
              {m.csv}
            </button>
            <button type="button" class="{BTN} px-2 py-1" onclick={() => download('json')}>
              {m.json}
            </button>
          </div>
        {/if}
      </div>

      {#if result.rows.length}
        <ResultTable columns={result.columns} rows={result.rows} labels={{ showMore: m.showMore }} />
      {:else}
        <p class="py-8 text-center text-sm text-berry-fg-3">{m.empty}</p>
      {/if}
    {:else if running}
      <p class="py-8 text-center text-sm text-berry-fg-3">{m.stage[stage] ?? m.stage.query}</p>
    {:else if !ran}
      <p class="py-8 text-center text-sm text-berry-fg-3">{m.idle}</p>
    {/if}
  </div>
</section>
