<script>
  // 歌曲列表（wiki 式編輯：任何人可改，無 auth）
  // 版面：頁首（標題＋筆數／同步狀態）→ 一條工具列 → 虛擬滾動表格 → 右側 drawer 表單
  import Page from '../lib/Page.svelte'
  import DataTable from '../lib/table/DataTable.svelte'
  import Drawer from '../lib/table/Drawer.svelte'
  import ConfirmDialog from '../lib/table/ConfirmDialog.svelte'
  import SearchBox from '../lib/table/SearchBox.svelte'
  import Toolbar from '../lib/table/Toolbar.svelte'
  import DownloadMenu from '../lib/table/DownloadMenu.svelte'
  import SyncStatus from '../lib/table/SyncStatus.svelte'
  import Button from '../lib/table/Button.svelte'
  import Field from '../lib/table/Field.svelte'
  import TextInput from '../lib/table/TextInput.svelte'
  import Alert from '../lib/table/Alert.svelte'

  import { t, getLang } from '../i18n.svelte.js'
  import { songlist } from '../api/store.svelte.js'
  import { apiPost, apiPut, apiDelete } from '../api/client.js'
  import {
    tokenize,
    filterRows,
    applySort,
    fieldErrorMap,
    nullIfBlank,
    syntaxName,
  } from '../lib/table/utils.js'

  songlist.load()

  /* ---------- 頁面局部字典（共通字走共享字典 t()） ---------- */
  const msgs = {
    zh: {
      searchPlaceholder: '搜尋全部欄位…（歌手:xx 類型:xx）',
      addTitle: '新增歌曲',
      editTitle: '編輯歌曲',
      deleteTitle: '刪除歌曲',
      deleteMessage: '確定要刪除「{name}」？此操作無法復原。',
      inUse: '這首歌已被歌單引用，請先移除相關歌單列再刪除。',
      nameRequired: '曲名為必填',
      rateLimited: '寫入太頻繁（每分鐘 30 次上限），請稍候再試。',
      discardTitle: '放棄未儲存的變更？',
      discardMessage: '表單有尚未儲存的修改，關閉後將遺失。',
      discardOk: '關閉不儲存',
      filtered: '篩選後 {n} 筆',
    },
    en: {
      searchPlaceholder: 'Search all columns… (artist:xx genre:xx)',
      addTitle: 'Add song',
      editTitle: 'Edit song',
      deleteTitle: 'Delete song',
      deleteMessage: 'Delete “{name}”? This cannot be undone.',
      inUse: 'This song is referenced by set lists. Remove those rows first.',
      nameRequired: 'Title is required',
      rateLimited: 'Too many writes (30/min limit). Please retry shortly.',
      discardTitle: 'Discard unsaved changes?',
      discardMessage: 'The form has unsaved edits that will be lost.',
      discardOk: 'Close without saving',
      filtered: '{n} filtered',
    },
    ja: {
      searchPlaceholder: '全項目を検索…（アーティスト:xx ジャンル:xx）',
      addTitle: '曲を追加',
      editTitle: '曲を編集',
      deleteTitle: '曲を削除',
      deleteMessage: '「{name}」を削除しますか？元に戻せません。',
      inUse: 'この曲はセットリストで使用中です。先に該当行を削除してください。',
      nameRequired: '曲名は必須です',
      rateLimited: '書き込みが多すぎます（毎分30回）。少し待って再試行してください。',
      discardTitle: '未保存の変更を破棄しますか？',
      discardMessage: '保存していない編集内容が失われます。',
      discardOk: '保存せずに閉じる',
      filtered: '絞り込み {n} 件',
    },
  }
  const m = $derived(msgs[getLang()] ?? msgs.zh)

  /* ---------- 表格 ---------- */
  const columns = $derived([
    { key: 'songName', label: t('field.songName'), width: 'minmax(180px, 2.2fr)' },
    { key: 'artist', label: t('field.artist'), width: 'minmax(140px, 1.6fr)' },
    { key: 'genre', label: t('field.genre'), width: '120px' },
    { key: 'tieup', label: t('field.tieup'), width: 'minmax(120px, 1.2fr)' },
    { key: 'songNote', label: t('field.songNote'), width: 'minmax(120px, 1.2fr)' },
  ])

  const SEARCH_FIELDS = [
    'songID',
    'songName',
    'songNameEn',
    'artist',
    'artistEn',
    'genre',
    'tieup',
    'songNote',
  ]

  // 欄位限定語法（`歌手:xx`）的別名表：中／英／日都收，key 一律小寫
  const F_SONG = ['songName', 'songNameEn']
  const F_ARTIST = ['artist', 'artistEn']
  const SEARCH_ALIASES = {
    曲名: F_SONG,
    song: F_SONG,
    songname: F_SONG,
    歌手: F_ARTIST,
    artist: F_ARTIST,
    アーティスト: F_ARTIST,
    類型: ['genre'],
    genre: ['genre'],
    ジャンル: ['genre'],
    連動: ['tieup'],
    tieup: ['tieup'],
    タイアップ: ['tieup'],
    備註: ['songNote'],
    note: ['songNote'],
    メモ: ['songNote'],
  }

  /** 搜尋框「?」說明：可用欄位與範例（隨語言切換） */
  const searchHelp = $derived.by(() => {
    const lang = getLang()
    const n = (zh, ja, en) => (lang === 'en' ? en : lang === 'ja' ? ja : zh)
    return {
      fields: [
        { syntax: syntaxName(lang, '曲名', '曲名', 'song'), label: t('field.songName') },
        { syntax: syntaxName(lang, '歌手', 'アーティスト', 'artist'), label: t('field.artist') },
        { syntax: syntaxName(lang, '類型', 'ジャンル', 'genre'), label: t('field.genre') },
        { syntax: syntaxName(lang, '連動', 'タイアップ', 'tieup'), label: t('field.tieup') },
        { syntax: syntaxName(lang, '備註', 'メモ', 'note'), label: t('field.songNote') },
      ],
      // 範例可直接點擊套用，值取自實際資料才不會點下去 0 筆
      examples: [
        `${n('類型', 'ジャンル', 'genre')}:アニソン ${n('歌手', 'アーティスト', 'artist')}:芹澤優`,
        `${n('歌手', 'アーティスト', 'artist')}:"苺咲べりぃ"`,
      ],
    }
  })

  let query = $state('')
  let sort = $state(null)

  const filtered = $derived(
    filterRows(songlist.rows, tokenize(query), SEARCH_FIELDS, SEARCH_ALIASES),
  )
  const view = $derived(applySort(filtered, sort, columns))

  const exportCols = $derived([
    { key: 'songID', label: t('field.songID') },
    { key: 'songName', label: t('field.songName') },
    { key: 'songNameEn', label: t('field.songNameEn') },
    { key: 'artist', label: t('field.artist') },
    { key: 'artistEn', label: t('field.artistEn') },
    { key: 'genre', label: t('field.genre') },
    { key: 'tieup', label: t('field.tieup') },
    { key: 'songNote', label: t('field.songNote') },
  ])

  const subtitle = $derived(
    t('common.rowCount', { n: songlist.rows.length }) +
      (view.length !== songlist.rows.length ? ` · ${m.filtered.replace('{n}', view.length)}` : ''),
  )

  /* ---------- Drawer 表單 ---------- */
  const blank = () => ({
    songName: '',
    songNameEn: '',
    artist: '',
    artistEn: '',
    genre: '',
    tieup: '',
    songNote: '',
  })

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
          songName: row.songName ?? '',
          songNameEn: row.songNameEn ?? '',
          artist: row.artist ?? '',
          artistEn: row.artistEn ?? '',
          genre: row.genre ?? '',
          tieup: row.tieup ?? '',
          songNote: row.songNote ?? '',
        }
      : blank()
    snapshot = JSON.stringify(form)
    formError = ''
    fieldErrors = {}
    deleteError = ''
    drawerSeq++
    drawerOpen = true
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
    formError = err?.status === 429 ? m.rateLimited : err?.message || String(err)
  }

  async function save() {
    if (saving) return
    formError = ''
    fieldErrors = {}

    const payload = {
      songName: nullIfBlank(form.songName),
      songNameEn: nullIfBlank(form.songNameEn),
      artist: nullIfBlank(form.artist),
      artistEn: nullIfBlank(form.artistEn),
      genre: nullIfBlank(form.genre),
      tieup: nullIfBlank(form.tieup),
      songNote: nullIfBlank(form.songNote),
    }
    if (!payload.songName) {
      fieldErrors = { songName: m.nameRequired }
      return
    }

    saving = true
    try {
      if (editing) {
        const res = await apiPut(`/api/songlist/${editing.songID}`, payload)
        const updated =
          res && typeof res === 'object' && res.songID != null
            ? res
            : { ...editing, ...payload }
        await songlist.applyLocalUpdate(updated)
      } else {
        const res = await apiPost('/api/songlist', payload)
        if (res && typeof res === 'object' && res.songID != null) {
          await songlist.applyLocalInsert(res)
        } else {
          await songlist.reload() // 回應形狀非預期：整包重抓保底
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
      await apiDelete(`/api/songlist/${editing.songID}`)
      await songlist.applyLocalDelete(editing.songID)
      deleteOpen = false
      drawerOpen = false
    } catch (err) {
      deleteError =
        err?.status === 409 ? m.inUse : err?.status === 429 ? m.rateLimited : err?.message || String(err)
    } finally {
      deleting = false
    }
  }
</script>

<Page title={t('page.songlist')} {subtitle} wide>
  {#snippet toolbar()}
    <SyncStatus store={songlist} />
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
      <DownloadMenu rows={view} cols={exportCols} basename="songlist" />
    {/snippet}
  </Toolbar>

  <DataTable
    rows={view}
    {columns}
    keyOf={(r) => r.songID}
    rowHeight={64}
    mobileRowHeight={104}
    minWidth={820}
    {sort}
    onsort={(s) => (sort = s)}
    onedit={openForm}
    loading={songlist.loading}
  >
    {#snippet cell(row, col)}
      {#if col.key === 'songName'}
        <span class="truncate" title={row.songName || undefined}>{row.songName ?? '—'}</span>
        {#if row.songNameEn}
          <span class="truncate text-sm text-berry-fg-3" title={row.songNameEn}>{row.songNameEn}</span>
        {/if}
      {:else if col.key === 'artist'}
        <span class="truncate text-berry-fg-2" title={row.artist || undefined}>{row.artist ?? '—'}</span>
        {#if row.artistEn}
          <span class="truncate text-sm text-berry-fg-3" title={row.artistEn}>{row.artistEn}</span>
        {/if}
      {:else}
        <span class="truncate text-berry-fg-2" title={row[col.key] || undefined}>
          {row[col.key] ?? ''}
        </span>
      {/if}
    {/snippet}

    {#snippet card(row)}
      <div class="flex h-full flex-col justify-center gap-0.5">
        <div class="truncate text-sm">{row.songName ?? '—'}</div>
        {#if row.songNameEn}
          <div class="truncate text-sm text-berry-fg-3">{row.songNameEn}</div>
        {/if}
        <div class="truncate text-sm text-berry-fg-2">
          {row.artist ?? ''}{row.genre ? ` · ${row.genre}` : ''}
        </div>
      </div>
    {/snippet}
  </DataTable>
</Page>

<Drawer
  open={drawerOpen}
  title={editing ? m.editTitle : m.addTitle}
  subtitle={editing ? `#${editing.songID}` : ''}
  onclose={requestClose}
>
  {#key drawerSeq}
    {#if formError}
      <Alert>{formError}</Alert>
    {/if}

    <Field label={t('field.songName')} required error={fieldErrors.songName} forId="song-name">
      <TextInput id="song-name" bind:value={form.songName} maxlength={500} invalid={!!fieldErrors.songName} />
    </Field>

    <Field label={t('field.songNameEn')} error={fieldErrors.songNameEn} forId="song-name-en">
      <TextInput id="song-name-en" bind:value={form.songNameEn} maxlength={500} />
    </Field>

    <Field label={t('field.artist')} error={fieldErrors.artist} forId="song-artist">
      <TextInput id="song-artist" bind:value={form.artist} maxlength={500} />
    </Field>

    <Field label={t('field.artistEn')} error={fieldErrors.artistEn} forId="song-artist-en">
      <TextInput id="song-artist-en" bind:value={form.artistEn} maxlength={500} />
    </Field>

    <Field label={t('field.genre')} error={fieldErrors.genre} forId="song-genre">
      <TextInput id="song-genre" bind:value={form.genre} maxlength={500} />
    </Field>

    <Field label={t('field.tieup')} error={fieldErrors.tieup} forId="song-tieup">
      <TextInput id="song-tieup" bind:value={form.tieup} maxlength={500} />
    </Field>

    <Field label={t('field.songNote')} error={fieldErrors.songNote} forId="song-note">
      <TextInput id="song-note" multiline rows={3} bind:value={form.songNote} maxlength={500} />
    </Field>
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
  message={m.deleteMessage.replace('{name}', editing?.songName ?? '')}
  confirmLabel={t('common.delete')}
  busy={deleting}
  error={deleteError}
  onconfirm={remove}
  oncancel={() => (deleteOpen = false)}
/>
