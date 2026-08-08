<script>
  // 直播列表（wiki 式編輯）
  import Page from '../lib/Page.svelte'
  import DataTable from '../lib/table/DataTable.svelte'
  import Drawer from '../lib/table/Drawer.svelte'
  import ConfirmDialog from '../lib/table/ConfirmDialog.svelte'
  import SearchBox from '../lib/table/SearchBox.svelte'
  import Toolbar from '../lib/table/Toolbar.svelte'
  import DownloadMenu from '../lib/table/DownloadMenu.svelte'
  import SyncStatus from '../lib/table/SyncStatus.svelte'
  import FilterChips from '../lib/table/FilterChips.svelte'
  import Button from '../lib/table/Button.svelte'
  import Field from '../lib/table/Field.svelte'
  import TextInput from '../lib/table/TextInput.svelte'
  import TagInput from '../lib/table/TagInput.svelte'
  import Alert from '../lib/table/Alert.svelte'

  import { t, getLang } from '../i18n.svelte.js'
  import { streamlist } from '../api/store.svelte.js'
  import { apiPost, apiPut, apiDelete } from '../api/client.js'
  import {
    tokenize,
    matchesQuery,
    applySort,
    syntaxName,
    labelWithTz,
    fieldErrorMap,
    nullIfBlank,
    formatDateTime,
    formatDate,
    toDatetimeLocalValue,
    fromDatetimeLocalValue,
    parseYouTubeId,
    ytWatchUrl,
    thumbUrl,
    ytThumbUrl,
    YT_ID_RE,
  } from '../lib/table/utils.js'

  streamlist.load()

  const msgs = {
    zh: {
      searchPlaceholder: '搜尋全部欄位…（標題:xx 分類:xx）',
      localTime: '本地時間',
      addTitle: '新增直播',
      editTitle: '編輯直播',
      deleteTitle: '刪除直播',
      deleteMessage: '確定要刪除「{name}」？此操作無法復原。',
      inUse: '這場直播已被歌單引用，請先移除相關歌單列再刪除。',
      exists: '這個直播 ID 已存在於列表中。',
      urlLabel: 'YouTube 網址或影片 ID',
      urlHint: '貼上網址會自動抽出影片 ID（watch / youtu.be / live / shorts 皆可）',
      idInvalid: '無法解析出有效的 YouTube 影片 ID',
      titleRequired: '標題為必填',
      timeRequired: '時間為必填',
      categoriesHint: '按 Enter 或逗號新增；點下方建議可快速套用',
      rateLimited: '寫入太頻繁（每分鐘 30 次上限），請稍候再試。',
      discardTitle: '放棄未儲存的變更？',
      discardMessage: '表單有尚未儲存的修改，關閉後將遺失。',
      discardOk: '關閉不儲存',
      filtered: '篩選後 {n} 筆',
      noCategory: '無分類',
      openYt: '在 YouTube 開啟',
    },
    en: {
      searchPlaceholder: 'Search all columns… (title:xx category:xx)',
      localTime: 'Local time',
      addTitle: 'Add stream',
      editTitle: 'Edit stream',
      deleteTitle: 'Delete stream',
      deleteMessage: 'Delete “{name}”? This cannot be undone.',
      inUse: 'This stream is referenced by set lists. Remove those rows first.',
      exists: 'This stream ID already exists.',
      urlLabel: 'YouTube URL or video ID',
      urlHint: 'Pasting a URL extracts the video ID (watch / youtu.be / live / shorts).',
      idInvalid: 'Could not parse a valid YouTube video ID',
      titleRequired: 'Title is required',
      timeRequired: 'Time is required',
      categoriesHint: 'Press Enter or comma to add; tap a suggestion below.',
      rateLimited: 'Too many writes (30/min limit). Please retry shortly.',
      discardTitle: 'Discard unsaved changes?',
      discardMessage: 'The form has unsaved edits that will be lost.',
      discardOk: 'Close without saving',
      filtered: '{n} filtered',
      noCategory: 'Uncategorised',
      openYt: 'Open in YouTube',
    },
    ja: {
      searchPlaceholder: '全項目を検索…（タイトル:xx カテゴリ:xx）',
      localTime: '現地時間',
      addTitle: '配信を追加',
      editTitle: '配信を編集',
      deleteTitle: '配信を削除',
      deleteMessage: '「{name}」を削除しますか？元に戻せません。',
      inUse: 'この配信はセットリストで使用中です。先に該当行を削除してください。',
      exists: 'この配信 ID は既に登録されています。',
      urlLabel: 'YouTube の URL または動画 ID',
      urlHint: 'URL を貼ると動画 ID を自動抽出します（watch / youtu.be / live / shorts）',
      idInvalid: '有効な YouTube 動画 ID を取得できませんでした',
      titleRequired: 'タイトルは必須です',
      timeRequired: '時間は必須です',
      categoriesHint: 'Enter またはカンマで追加。下の候補をタップでも可。',
      rateLimited: '書き込みが多すぎます（毎分30回）。少し待って再試行してください。',
      discardTitle: '未保存の変更を破棄しますか？',
      discardMessage: '保存していない編集内容が失われます。',
      discardOk: '保存せずに閉じる',
      filtered: '絞り込み {n} 件',
      noCategory: 'カテゴリなし',
      openYt: 'YouTube で開く',
    },
  }
  const m = $derived(msgs[getLang()] ?? msgs.zh)

  /* ---------- 表格 ---------- */
  const columns = $derived([
    { key: 'thumb', label: '', width: '176px', sortable: false },
    { key: 'title', label: t('field.title'), width: 'minmax(200px, 2.4fr)' },
    { key: 'time', label: labelWithTz(t('field.time')), width: '176px' },
    { key: 'categories', label: t('field.categories'), width: 'minmax(140px, 1.2fr)', sortable: false },
    { key: 'note', label: t('field.note'), width: 'minmax(120px, 1fr)' },
  ])

  const SEARCH_FIELDS = [
    'streamID',
    'title',
    'note',
    (r) => (Array.isArray(r.categories) ? r.categories.join(' ') : ''),
    (r) => formatDate(r.time),
  ]

  // 欄位限定語法（`分類:歌枠`）的別名表：中／英／日都收，key 一律小寫
  const F_CAT = [(r) => (Array.isArray(r.categories) ? r.categories.join(' ') : '')]
  const SEARCH_ALIASES = {
    標題: ['title'],
    title: ['title'],
    タイトル: ['title'],
    分類: F_CAT,
    cat: F_CAT,
    category: F_CAT,
    categories: F_CAT,
    カテゴリ: F_CAT,
    備註: ['note'],
    note: ['note'],
    メモ: ['note'],
    id: ['streamID'],
    streamid: ['streamID'],
  }

  const searchHelp = $derived.by(() => {
    const lang = getLang()
    const n = (zh, ja, en) => (lang === 'en' ? en : lang === 'ja' ? ja : zh)
    return {
      fields: [
        { syntax: syntaxName(lang, '標題', 'タイトル', 'title'), label: t('field.title') },
        { syntax: syntaxName(lang, '分類', 'カテゴリ', 'category'), label: t('field.categories') },
        { syntax: syntaxName(lang, '備註', 'メモ', 'note'), label: t('field.note') },
        { syntax: 'id', label: t('field.streamID') },
      ],
      // 範例可直接點擊套用，值取自實際資料才不會點下去 0 筆
      examples: [
        `${n('分類', 'カテゴリ', 'category')}:歌枠 2026`,
        `${n('標題', 'タイトル', 'title')}:"karaoke"`,
      ],
    }
  })

  let query = $state('')
  let sort = $state(null)
  let catFilter = $state([])

  /** 分類 distinct（依出現次數排序） */
  const categoryOptions = $derived.by(() => {
    const counts = new Map()
    for (const row of streamlist.rows) {
      for (const c of row.categories ?? []) counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: value, count }))
  })

  const allCategoryNames = $derived(categoryOptions.map((o) => o.value))

  const filtered = $derived.by(() => {
    const tokens = tokenize(query)
    const cats = catFilter
    if (!tokens.length && !cats.length) return streamlist.rows
    return streamlist.rows.filter((row) => {
      if (cats.length) {
        const rowCats = row.categories ?? []
        if (!cats.some((c) => rowCats.includes(c))) return false
      }
      return !tokens.length || matchesQuery(row, tokens, SEARCH_FIELDS, SEARCH_ALIASES)
    })
  })

  const view = $derived(applySort(filtered, sort, columns))

  const exportCols = $derived([
    { key: 'streamID', label: t('field.streamID') },
    { key: 'title', label: t('field.title') },
    { key: 'time', label: t('field.time'), value: (r) => formatDateTime(r.time) },
    { key: 'categories', label: t('field.categories'), value: (r) => (r.categories ?? []).join(' / ') },
    { key: 'note', label: t('field.note') },
    { key: 'setlistComplete', label: 'setlistComplete' },
  ])

  const subtitle = $derived(
    t('common.rowCount', { n: streamlist.rows.length }) +
      (view.length !== streamlist.rows.length ? ` · ${m.filtered.replace('{n}', view.length)}` : ''),
  )

  function onThumbError(e) {
    const img = e.currentTarget
    if (img.dataset.fb === '1') return // once：避免 fallback 也失敗時無限迴圈
    img.dataset.fb = '1'
    img.src = ytThumbUrl(img.dataset.id ?? '')
  }

  /* ---------- Drawer ---------- */
  const blank = () => ({ url: '', streamID: '', title: '', time: '', categories: [], note: '' })

  let drawerOpen = $state(false)
  let editing = $state(null)
  let form = $state(blank())
  let snapshot = $state('')
  let saving = $state(false)
  let formError = $state('')
  let fieldErrors = $state({})
  let drawerSeq = $state(0)

  let discardOpen = $state(false)
  let deleteOpen = $state(false)
  let deleting = $state(false)
  let deleteError = $state('')

  const dirty = $derived(JSON.stringify(form) !== snapshot)

  function openForm(row) {
    editing = row
    form = row
      ? {
          url: '',
          streamID: row.streamID,
          title: row.title ?? '',
          time: toDatetimeLocalValue(row.time),
          categories: [...(row.categories ?? [])],
          note: row.note ?? '',
        }
      : blank()
    snapshot = JSON.stringify(form)
    formError = ''
    fieldErrors = {}
    deleteError = ''
    drawerSeq++
    drawerOpen = true
  }

  /** 新增模式：貼上網址即時解析出 streamID */
  function onUrlInput() {
    const id = parseYouTubeId(form.url)
    if (id) {
      form.streamID = id
      fieldErrors = { ...fieldErrors, streamID: '' }
    }
  }

  function requestClose() {
    if (saving) return
    if (dirty) {
      discardOpen = true
      return
    }
    drawerOpen = false
  }

  function forceClose() {
    discardOpen = false
    drawerOpen = false
  }

  function handleError(err) {
    fieldErrors = fieldErrorMap(err)
    formError =
      err?.status === 429
        ? m.rateLimited
        : err?.status === 409
          ? m.exists
          : err?.message || String(err)
  }

  async function save() {
    if (saving) return
    formError = ''
    fieldErrors = {}

    const errs = {}
    const id = String(form.streamID ?? '').trim()
    if (!editing && !YT_ID_RE.test(id)) errs.streamID = m.idInvalid
    const title = nullIfBlank(form.title)
    if (!title) errs.title = m.titleRequired
    const iso = fromDatetimeLocalValue(form.time)
    if (!iso) errs.time = m.timeRequired
    if (Object.keys(errs).length) {
      fieldErrors = errs
      return
    }

    saving = true
    try {
      if (editing) {
        const payload = {
          title,
          time: iso,
          categories: [...form.categories],
          note: nullIfBlank(form.note),
        }
        const res = await apiPut(`/api/streamlist/${encodeURIComponent(editing.streamID)}`, payload)
        const updated =
          res && typeof res === 'object' && res.streamID ? res : { ...editing, ...payload }
        await streamlist.applyLocalUpdate(updated)
      } else {
        const payload = {
          streamID: id,
          title,
          time: iso,
          categories: [...form.categories],
          note: nullIfBlank(form.note),
        }
        const res = await apiPost('/api/streamlist', payload)
        if (res && typeof res === 'object' && res.streamID) {
          await streamlist.applyLocalInsert(res)
        } else {
          await streamlist.reload()
        }
      }
      drawerOpen = false
    } catch (err) {
      handleError(err)
    } finally {
      saving = false
    }
  }

  async function remove() {
    if (!editing || deleting) return
    deleting = true
    deleteError = ''
    try {
      await apiDelete(`/api/streamlist/${encodeURIComponent(editing.streamID)}`)
      await streamlist.applyLocalDelete(editing.streamID)
      deleteOpen = false
      drawerOpen = false
    } catch (err) {
      deleteError =
        err?.status === 409
          ? m.inUse
          : err?.status === 429
            ? m.rateLimited
            : err?.message || String(err)
    } finally {
      deleting = false
    }
  }
</script>

<Page title={t('page.streamlist')} {subtitle} wide>
  {#snippet toolbar()}
    <SyncStatus store={streamlist} />
  {/snippet}

  <Toolbar>
    <SearchBox
      bind:value={query}
      placeholder={m.searchPlaceholder}
      helpFields={searchHelp.fields}
      helpExamples={searchHelp.examples}
    />

    {#snippet actions()}
      <Button variant="primary" onclick={() => openForm(null)}>
        <span class="text-base leading-none">＋</span>
        {t('common.add')}
      </Button>
      <DownloadMenu rows={view} cols={exportCols} basename="streamlist" />
    {/snippet}
  </Toolbar>

  {#if categoryOptions.length}
    <div class="mb-3 -mt-0.5">
      <FilterChips
        options={categoryOptions}
        selected={catFilter}
        onchange={(next) => (catFilter = next)}
      />
    </div>
  {/if}

  <DataTable
    rows={view}
    {columns}
    keyOf={(r) => r.streamID}
    rowHeight={108}
    mobileRowHeight={110}
    minWidth={880}
    {sort}
    onsort={(s) => (sort = s)}
    onedit={openForm}
    loading={streamlist.loading}
  >
    {#snippet cell(row, col)}
      {#if col.key === 'thumb'}
        <img
          src={thumbUrl(row.streamID)}
          data-id={row.streamID}
          alt=""
          width="160"
          height="90"
          loading="lazy"
          decoding="async"
          class="h-[90px] w-40 rounded border border-berry-border bg-berry-bg-3 object-cover"
          onerror={onThumbError}
        />
      {:else if col.key === 'title'}
        <a
          href={ytWatchUrl(row.streamID)}
          target="_blank"
          rel="noopener noreferrer"
          class="line-clamp-2 no-underline hover:underline"
          title={row.title ?? ''}
        >
          {row.title ?? row.streamID}
        </a>
        <span class="truncate font-mono text-sm text-berry-fg-3" title={row.streamID}>
          {row.streamID}
        </span>
      {:else if col.key === 'time'}
        <span class="truncate text-berry-fg-2 tabular-nums" title={formatDateTime(row.time) || undefined}>
          {formatDateTime(row.time)}
        </span>
      {:else if col.key === 'categories'}
        <!-- 只顯示前 3 個，其餘靠 tooltip 讀 -->
        <div
          class="flex flex-wrap gap-1 overflow-hidden"
          title={(row.categories ?? []).join(' · ') || undefined}
        >
          {#each (row.categories ?? []).slice(0, 3) as c (c)}
            <span
              class="rounded-full border px-2 py-1 text-sm leading-none"
              style="background: var(--berry-subtle-bg); border-color: var(--berry-subtle-border); color: var(--berry-text-emphasis)"
            >
              {c}
            </span>
          {/each}
          {#if (row.categories ?? []).length > 3}
            <span class="text-sm text-berry-fg-3">+{row.categories.length - 3}</span>
          {/if}
        </div>
      {:else}
        <span class="truncate text-berry-fg-2" title={row[col.key] || undefined}>
          {row[col.key] ?? ''}
        </span>
      {/if}
    {/snippet}

    {#snippet card(row)}
      <div class="flex h-full items-center gap-2.5">
        <img
          src={thumbUrl(row.streamID)}
          data-id={row.streamID}
          alt=""
          width="160"
          height="90"
          loading="lazy"
          decoding="async"
          class="h-[45px] w-20 shrink-0 rounded border border-berry-border bg-berry-bg-3 object-cover"
          onerror={onThumbError}
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm">{row.title ?? row.streamID}</div>
          <div class="truncate text-sm text-berry-fg-3 tabular-nums">{formatDateTime(row.time)}</div>
          <div class="truncate text-sm text-berry-fg-3">
            {(row.categories ?? []).join(' · ')}
          </div>
        </div>
      </div>
    {/snippet}
  </DataTable>
</Page>

<Drawer
  open={drawerOpen}
  title={editing ? m.editTitle : m.addTitle}
  subtitle={editing ? editing.streamID : ''}
  onclose={requestClose}
>
  {#key drawerSeq}
    {#if formError}
      <Alert>{formError}</Alert>
    {/if}

    {#if !editing}
      <Field label={m.urlLabel} hint={m.urlHint} forId="stream-url">
        <TextInput
          id="stream-url"
          bind:value={form.url}
          placeholder="https://www.youtube.com/watch?v=…"
          oninput={onUrlInput}
        />
      </Field>
    {/if}

    <Field label={t('field.streamID')} required error={fieldErrors.streamID} forId="stream-id">
      <TextInput
        id="stream-id"
        bind:value={form.streamID}
        readonly={!!editing}
        invalid={!!fieldErrors.streamID}
        maxlength={11}
        class="font-mono"
      />
    </Field>

    <Field label={t('field.title')} required error={fieldErrors.title} forId="stream-title">
      <TextInput id="stream-title" bind:value={form.title} maxlength={500} invalid={!!fieldErrors.title} />
    </Field>

    <Field label={labelWithTz(m.localTime)} required error={fieldErrors.time} forId="stream-time">
      <TextInput
        id="stream-time"
        type="datetime-local"
        bind:value={form.time}
        invalid={!!fieldErrors.time}
      />
    </Field>

    <Field label={t('field.categories')} hint={m.categoriesHint} error={fieldErrors.categories}>
      <TagInput
        tags={form.categories}
        suggestions={allCategoryNames}
        onchange={(next) => (form.categories = next)}
      />
    </Field>

    <Field label={t('field.note')} error={fieldErrors.note}>
      <TextInput multiline rows={3} bind:value={form.note} maxlength={500} />
    </Field>

    {#if editing}
      <a
        href={ytWatchUrl(editing.streamID)}
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm no-underline hover:underline"
      >
        {m.openYt} ↗
      </a>
    {/if}
  {/key}

  {#snippet footer()}
    {#if editing}
      <Button
        variant="danger"
        onclick={() => {
          deleteError = ''
          deleteOpen = true
        }}
      >
        {t('common.delete')}
      </Button>
    {/if}
    <div class="flex-1"></div>
    <Button onclick={requestClose} disabled={saving}>{t('common.cancel')}</Button>
    <Button variant="primary" busy={saving} onclick={save}>{t('common.save')}</Button>
  {/snippet}
</Drawer>

<ConfirmDialog
  open={discardOpen}
  title={m.discardTitle}
  message={m.discardMessage}
  confirmLabel={m.discardOk}
  onconfirm={forceClose}
  oncancel={() => (discardOpen = false)}
/>

<ConfirmDialog
  open={deleteOpen}
  title={m.deleteTitle}
  message={m.deleteMessage.replace('{name}', editing?.title ?? editing?.streamID ?? '')}
  confirmLabel={t('common.delete')}
  busy={deleting}
  error={deleteError}
  onconfirm={remove}
  oncancel={() => (deleteOpen = false)}
/>
