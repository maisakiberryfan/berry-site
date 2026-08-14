<script>
  // 別名管理（wiki 式編輯）＋「測試別名」小工具
  // 注意：aliases 端點信封是 {success, data, isNew}，client.js 已統一解包；
  //       需要 isNew 時用 request() 讀 .raw。
  import Page from '../lib/Page.svelte'
  import DataTable from '../lib/table/DataTable.svelte'
  import Drawer from '../lib/table/Drawer.svelte'
  import ConfirmDialog from '../lib/table/ConfirmDialog.svelte'
  import SearchBox from '../lib/table/SearchBox.svelte'
  import Toolbar from '../lib/table/Toolbar.svelte'
  import DownloadMenu from '../lib/table/DownloadMenu.svelte'
  import SyncStatus from '../lib/table/SyncStatus.svelte'
  import FilterChips from '../lib/table/FilterChips.svelte'
  import Combobox from '../lib/table/Combobox.svelte'
  import Button from '../lib/table/Button.svelte'
  import Field from '../lib/table/Field.svelte'
  import TextInput from '../lib/table/TextInput.svelte'
  import Alert from '../lib/table/Alert.svelte'

  import { t, getLang } from '../i18n.svelte.js'
  import { aliases, songlist, songIndex } from '../api/store.svelte.js'
  import { request, apiPost, apiPut, apiDelete } from '../api/client.js'
  import {
    MOBILE_MQ,
    tokenize,
    matchesQuery,
    applySort,
    compileColumnFilters,
    matchesColumnFilters,
    countDistinct,
    syntaxName,
    fieldErrorMap,
    nullIfBlank,
  } from '../lib/table/utils.js'

  // 手機唯讀（鐵則 2）：新增鈕條件渲染用
  let isMobile = $state(false)
  $effect(() => {
    const mq = window.matchMedia(MOBILE_MQ)
    const apply = () => (isMobile = mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  })

  aliases.load()
  songlist.load()

  const msgs = {
    zh: {
      searchPlaceholder: '搜尋全部欄位…（別名:xx 類型:xx）',
      addTitle: '新增別名',
      editTitle: '編輯別名',
      testTitle: '測試別名',
      testButton: '測試別名',
      deleteTitle: '刪除別名',
      deleteMessage: '確定要刪除別名「{name}」？',
      typeTitle: '曲名',
      typeArtist: '歌手',
      boundSong: '綁定曲目',
      boundHint: 'title 別名可綁 songID，同名異曲才不會互染',
      canonicalHint: '從歌曲列表選取會自動帶入曲名與 songID',
      canonicalArtistHint: '歌手正式名稱（自由輸入，可用下方建議）',
      aliasHint: '解析歌單時會被視為同一首/同一位',
      canonicalRequired: '正式名稱為必填',
      aliasRequired: '別名為必填',
      inputText: '輸入文字',
      testHint: '輸入一段文字，看看會匹配到哪些正式名稱',
      run: '執行測試',
      matches: '匹配結果（{n}）',
      noMatch: '沒有匹配到任何別名',
      rateLimited: '寫入太頻繁（每分鐘 30 次上限），請稍候再試。',
      discardTitle: '放棄未儲存的變更？',
      discardMessage: '表單有尚未儲存的修改，關閉後將遺失。',
      discardOk: '關閉不儲存',
      filtered: '篩選後 {n} 筆',
      unbound: '未綁定',
      aliasUpdated: '別名「{v}」原本就存在，已更新既有那一筆（不是新增）。',
      aliasRebound: '⚠️ 這個別名原本指向其他歌曲，已改綁到目前選定的這一首。',
      newArtistTitle: '這位歌手不在資料庫中',
      newArtistMessage:
        '目前沒有任何歌曲使用「{name}」。確定要以這個名稱當正式名稱嗎？（打錯字的話，解析歌單時對不到任何一位歌手）',
      newArtistOk: '確定使用',
    },
    en: {
      searchPlaceholder: 'Search all columns… (alias:xx type:xx)',
      addTitle: 'Add alias',
      editTitle: 'Edit alias',
      testTitle: 'Test aliases',
      testButton: 'Test',
      deleteTitle: 'Delete alias',
      deleteMessage: 'Delete alias “{name}”?',
      typeTitle: 'Song title',
      typeArtist: 'Artist',
      boundSong: 'Bound song',
      boundHint: 'Title aliases can bind a songID so same-name songs stay separate.',
      canonicalHint: 'Picking from the song list fills in the title and songID.',
      canonicalArtistHint: 'Canonical artist name (free text; suggestions below).',
      aliasHint: 'Treated as the same song/artist when parsing set lists.',
      canonicalRequired: 'Canonical name is required',
      aliasRequired: 'Alias is required',
      inputText: 'Input text',
      testHint: 'Enter text to see which canonical names it matches.',
      run: 'Run test',
      matches: 'Matches ({n})',
      noMatch: 'No alias matched',
      rateLimited: 'Too many writes (30/min limit). Please retry shortly.',
      discardTitle: 'Discard unsaved changes?',
      discardMessage: 'The form has unsaved edits that will be lost.',
      discardOk: 'Close without saving',
      filtered: '{n} filtered',
      unbound: 'Unbound',
      aliasUpdated: 'Alias “{v}” already existed — the existing entry was updated, not added.',
      aliasRebound: '⚠️ This alias pointed at another song; it now binds to the selected one.',
      newArtistTitle: 'Artist not in the database',
      newArtistMessage:
        'No song uses “{name}” yet. Use it as the canonical name? (A typo here matches no artist when set lists are parsed.)',
      newArtistOk: 'Use this name',
    },
    ja: {
      searchPlaceholder: '全項目を検索…（エイリアス:xx タイプ:xx）',
      addTitle: '別名を追加',
      editTitle: '別名を編集',
      testTitle: '別名テスト',
      testButton: '別名テスト',
      deleteTitle: '別名を削除',
      deleteMessage: '別名「{name}」を削除しますか？',
      typeTitle: '曲名',
      typeArtist: 'アーティスト',
      boundSong: '紐づけ曲',
      boundHint: 'title 別名は songID を紐づけられます（同名異曲の混同防止）',
      canonicalHint: '曲リストから選ぶと曲名と songID が自動入力されます',
      canonicalArtistHint: 'アーティストの正式名称（自由入力・下の候補も利用可）',
      aliasHint: 'セットリスト解析時に同一とみなされます',
      canonicalRequired: '正式名称は必須です',
      aliasRequired: '別名は必須です',
      inputText: '入力テキスト',
      testHint: 'テキストを入力すると、どの正式名称に一致するか確認できます。',
      run: 'テスト実行',
      matches: '一致結果（{n}）',
      noMatch: '一致する別名はありません',
      rateLimited: '書き込みが多すぎます（毎分30回）。少し待って再試行してください。',
      discardTitle: '未保存の変更を破棄しますか？',
      discardMessage: '保存していない編集内容が失われます。',
      discardOk: '保存せずに閉じる',
      filtered: '絞り込み {n} 件',
      unbound: '未紐づけ',
      aliasUpdated: 'エイリアス「{v}」は既に存在したため、既存のデータを更新しました（新規追加ではありません）。',
      aliasRebound: '⚠️ このエイリアスは別の曲に紐づいていましたが、選択中の曲に付け替えました。',
      newArtistTitle: 'このアーティストはデータベースにありません',
      newArtistMessage:
        '「{name}」を使用している曲はまだありません。この名前を正式名称として使用しますか？（誤字があると、セットリスト解析時にどのアーティストにも一致しません）',
      newArtistOk: 'この名前を使う',
    },
  }
  const m = $derived(msgs[getLang()] ?? msgs.zh)

  const typeLabel = (type) => (type === 'artist' ? m.typeArtist : m.typeTitle)

  /* ---------- 表格 ---------- */
  const boundSongName = (row) =>
    row.songID != null ? (songIndex.map.get(row.songID)?.songName ?? `#${row.songID}`) : ''

  // 綁定曲目欄存的是 songID、顯示的是曲名，篩選要比使用者看得到的那個
  // （儲存格是兩行：曲名 ＋ #songID，兩行都要篩得到——只比曲名的話「#167」會 0 筆）
  const columns = $derived([
    { key: 'aliasType', label: t('field.aliasType'), width: '96px', filter: 'select' },
    { key: 'canonicalName', label: t('field.canonicalName'), width: 'minmax(150px, 1.6fr)' },
    { key: 'aliasValue', label: t('field.aliasValue'), width: 'minmax(150px, 1.6fr)' },
    {
      key: 'songID',
      label: m.boundSong,
      width: 'minmax(120px, 1.2fr)',
      // 排序依畫面上的曲名，不是 songID：這一欄顯示的是曲名，按 songID 排出來的順序
      // 在使用者眼中等於亂序（未綁定＝空字串，由 applySort 統一殿後）
      sortValue: (r) => (r.songID != null ? boundSongName(r) : ''),
      filterValue: (r) => (r.songID != null ? `${boundSongName(r)} #${r.songID}` : ''),
    },
    { key: 'note', label: t('field.note'), width: 'minmax(110px, 1fr)' },
  ])

  const SEARCH_FIELDS = ['canonicalName', 'aliasValue', 'note', 'aliasType', 'songID', boundSongName]

  // 欄位限定語法（`類型:artist`）的別名表：中／英／日都收，key 一律小寫
  const SEARCH_ALIASES = {
    類型: ['aliasType'],
    type: ['aliasType'],
    タイプ: ['aliasType'],
    種別: ['aliasType'],
    名稱: ['canonicalName'],
    名称: ['canonicalName'],
    name: ['canonicalName'],
    canonical: ['canonicalName'],
    正式名稱: ['canonicalName'],
    正式名: ['canonicalName'],
    別名: ['aliasValue'],
    alias: ['aliasValue'],
    value: ['aliasValue'],
    エイリアス: ['aliasValue'],
    備註: ['note'],
    note: ['note'],
    メモ: ['note'],
  }

  const searchHelp = $derived.by(() => {
    const lang = getLang()
    const n = (zh, ja, en) => (lang === 'en' ? en : lang === 'ja' ? ja : zh)
    return {
      fields: [
        { syntax: syntaxName(lang, '類型', 'タイプ', 'type'), label: 'title / artist' },
        { syntax: syntaxName(lang, '名稱', '名称', 'name'), label: t('field.canonicalName') },
        { syntax: syntaxName(lang, '別名', 'エイリアス', 'alias'), label: t('field.aliasValue') },
        { syntax: syntaxName(lang, '備註', 'メモ', 'note'), label: t('field.note') },
      ],
      // 範例可直接點擊套用，值取自實際資料才不會點下去 0 筆
      examples: [
        `${n('類型', 'タイプ', 'type')}:artist ${n('名稱', '名称', 'name')}:B小町`,
        `${n('別名', 'エイリアス', 'alias')}:"Folder 5"`,
      ],
    }
  })

  let query = $state('')
  let typeFilter = $state([])
  let sort = $state(null)
  /** 欄位篩選列的值 { 欄key: 值 }（DataTable 只給值，過濾在這裡疊加） */
  let colFilters = $state({})

  /**
   * 先排序、再篩選（四頁共用的作法）：排序結果只依賴「資料 ∧ 排序條件」，$derived 會替它
   * 快取——篩選每變一次（欄位篩選列每敲一鍵）都重排整表的成本因此消失。篩選保序、
   * Array#sort 穩定，輸出序列與「先篩後排」逐列相同。sort 為 null 時 applySort 原樣回傳。
   */
  const sorted = $derived(applySort(aliases.rows, sort, columns))

  /** 上方 chips：計數 cascade（隨 chips 以外全部條件收斂），與表頭 select 同語意 */
  const beforeChips = $derived.by(() => {
    const tokens = tokenize(query)
    const active = compileColumnFilters(colFilters, columns)
    if (!tokens.length && !active) return sorted
    return sorted.filter(
      (r) =>
        (!tokens.length || matchesQuery(r, tokens, SEARCH_FIELDS, SEARCH_ALIASES)) &&
        (!active || matchesColumnFilters(r, active)),
    )
  })

  const typeOptions = $derived.by(() => {
    const counts = countDistinct(beforeChips, (r) => r.aliasType)
    return [
      { value: 'title', label: m.typeTitle, count: counts.get('title') ?? 0 },
      { value: 'artist', label: m.typeArtist, count: counts.get('artist') ?? 0 },
    ]
  })

  // 兩段套用：先算「類型欄篩選以外的全部條件」（全域搜尋 ∧ chips ∧ 其他欄位篩選）——
  // 類型 select 的計數以此為基準（cascade：不裁選項，只更新計數）——再補類型 select 本身。
  const beforeType = $derived.by(() => {
    const tokens = tokenize(query)
    const types = typeFilter
    const active = compileColumnFilters(colFilters, columns, 'aliasType')
    if (!tokens.length && !types.length && !active) return sorted
    return sorted.filter((row) => {
      if (types.length && !types.includes(row.aliasType)) return false
      if (active && !matchesColumnFilters(row, active)) return false
      return !tokens.length || matchesQuery(row, tokens, SEARCH_FIELDS, SEARCH_ALIASES)
    })
  })

  const typeSelectOptions = $derived.by(() => {
    const counts = countDistinct(beforeType, (r) => r.aliasType)
    return typeOptions.map((o) => ({ ...o, count: counts.get(o.value) ?? 0 }))
  })

  const view = $derived.by(() => {
    const ty = String(colFilters.aliasType ?? '')
    return ty ? beforeType.filter((row) => row.aliasType === ty) : beforeType
  })

  /** 傳給 DataTable 的欄定義：select 的動態選項另外併上去（避免 columns 反向依賴篩選結果） */
  const tableColumns = $derived(
    columns.map((c) => (c.key === 'aliasType' ? { ...c, filterOptions: typeSelectOptions } : c)),
  )

  const exportCols = $derived([
    { key: 'aliasID', label: 'aliasID' },
    { key: 'aliasType', label: t('field.aliasType') },
    { key: 'canonicalName', label: t('field.canonicalName') },
    { key: 'aliasValue', label: t('field.aliasValue') },
    { key: 'songID', label: t('field.songID') },
    { key: 'boundSong', label: m.boundSong, value: boundSongName },
    { key: 'note', label: t('field.note') },
  ])

  const subtitle = $derived(
    t('common.rowCount', { n: aliases.rows.length }) +
      (view.length !== aliases.rows.length ? ` · ${m.filtered.replace('{n}', view.length)}` : ''),
  )

  /** 選歌下拉（title 別名綁定用） */
  const songOptions = $derived(
    songlist.rows.map((s) => ({
      id: s.songID,
      label: s.songName || `#${s.songID}`,
      sub: [s.songNameEn, s.artist].filter(Boolean).join(' · '),
      search: [s.songID, s.songName, s.songNameEn, s.artist, s.artistEn]
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
    })),
  )

  /** 既有歌手名（完整集合）：送出前判斷「這個正式名稱是不是新歌手」用 */
  const artistNames = $derived.by(() => {
    const set = new Set()
    for (const s of songlist.rows) {
      const name = String(s.artist ?? '').trim()
      if (name) set.add(name)
    }
    return set
  })

  /** 歌手建議（datalist）。⚠️ 有截斷，只能拿來當建議，判斷「是否為既有歌手」要用 artistNames */
  const artistSuggestions = $derived(
    [...artistNames].sort((a, b) => a.localeCompare(b)).slice(0, 400),
  )

  /* ---------- Drawer ---------- */
  const blank = () => ({
    aliasType: 'title',
    canonicalName: '',
    aliasValue: '',
    songID: null,
    note: '',
  })

  let mode = $state(null) // 'form' | 'test'
  let drawerOpen = $state(false)
  let drawerSeq = $state(0)
  let editing = $state(null)
  let form = $state(blank())
  let snapshot = $state('')
  let saving = $state(false)
  let formError = $state('')
  /** 後端原文（英文），降級成主訊息下方的小字技術細節 */
  let formErrorDetail = $state('')
  let fieldErrors = $state({})

  let discardOpen = $state(false)
  let deleteOpen = $state(false)
  let deleting = $state(false)
  let deleteError = $state('')
  /** 正式名稱是新歌手時的軟確認（僅 artist 型別；自由輸入欄，打錯字沒有東西擋得住） */
  let newArtistOpen = $state(false)

  /** 頁級提示 { text, kind }：drawer 關掉之後仍要讓使用者看到 upsert 的實際結果 */
  let notice = $state(null)
  let noticeTimer

  function showNotice(text, kind = 'success') {
    notice = { text, kind }
    clearTimeout(noticeTimer)
    // 警示留久一點（改綁是可能要回頭處理的事），一般結果訊息看過就好
    noticeTimer = setTimeout(() => (notice = null), kind === 'warn' ? 15000 : 8000)
  }

  $effect(() => () => clearTimeout(noticeTimer))

  // 測試工具
  let testForm = $state({ aliasType: 'title', inputText: '' })
  let testing = $state(false)
  let testResult = $state(null)
  let testError = $state('')

  const dirty = $derived(mode === 'form' && JSON.stringify(form) !== snapshot)

  function openForm(row) {
    mode = 'form'
    editing = row
    form = row
      ? {
          aliasType: row.aliasType,
          canonicalName: row.canonicalName ?? '',
          aliasValue: row.aliasValue ?? '',
          songID: row.songID ?? null,
          note: row.note ?? '',
        }
      : blank()
    snapshot = JSON.stringify(form)
    formError = ''
    formErrorDetail = ''
    fieldErrors = {}
    deleteError = ''
    drawerSeq++
    drawerOpen = true
  }

  function openTest() {
    mode = 'test'
    editing = null
    testResult = null
    testError = ''
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

  /* ---------- 錯誤呈現 ----------
     後端訊息一律是英文，而且多半是 'invalid' / 'Validation failed' 這種機器語彙——
     直接上畫面對三語站的使用者等於沒有訊息。看得懂的那一句由 HTTP status 決定，
     後端原文降級成小字（回報問題時仍找得到）。 */

  /** HTTP status → 三語一句 */
  function errorText(err) {
    const s = Number(err?.status) || 0
    if (s === 400) return t('common.errValidation')
    if (s === 404) return t('common.errNotFound')
    if (s === 409) return t('common.errConflict')
    if (s === 429) return m.rateLimited
    if (s >= 500) return t('common.errServer')
    if (s === 0) return t('common.errNetwork') // status 0＝逾時／連線失敗（見 client.js）
    return t('common.errUnknown')
  }

  /** 後端原文（與主訊息重複時不顯示） */
  function errorDetail(err) {
    const s = String(err?.message ?? '').trim()
    return s && s !== errorText(err) ? s : ''
  }

  /** 欄位錯誤：後端給的是機器碼（'invalid'／'required'），換成本頁的三語訊息 */
  const FIELD_MESSAGES = $derived({
    canonicalName: m.canonicalRequired,
    aliasValue: m.aliasRequired,
  })

  function localizedFieldErrors(err) {
    const out = {}
    for (const key of Object.keys(fieldErrorMap(err))) {
      out[key] = FIELD_MESSAGES[key] ?? t('common.errField')
    }
    return out
  }

  function handleError(err) {
    fieldErrors = localizedFieldErrors(err)
    formError = errorText(err)
    formErrorDetail = errorDetail(err)
  }

  function onPickSong(o) {
    form.songID = o ? o.id : null
    if (o) form.canonicalName = o.label
  }

  /**
   * artist 型別的正式名稱是自由輸入（datalist 只是建議）：打錯一個字，這條別名就永遠
   * 對不到任何歌手——解析歌單時看起來「有登記卻沒生效」，最難查。送出前確認一次，不阻擋
   * （新歌手本來就得有人第一次寫）。title 型別綁 songID，不適用。
   */
  function requestSave() {
    if (saving) return
    const name = String(form.canonicalName ?? '').trim()
    // 必填未過時直接送，讓既有的必填驗證先講話（先跳確認框再說「別名必填」很怪）
    if (form.aliasType === 'artist' && name && nullIfBlank(form.aliasValue) && !artistNames.has(name)) {
      newArtistOpen = true
      return
    }
    save()
  }

  async function save() {
    newArtistOpen = false
    if (saving) return
    formError = ''
    formErrorDetail = ''
    fieldErrors = {}

    const canonicalName = nullIfBlank(form.canonicalName)
    const aliasValue = nullIfBlank(form.aliasValue)
    const errs = {}
    if (!canonicalName) errs.canonicalName = m.canonicalRequired
    if (!aliasValue) errs.aliasValue = m.aliasRequired
    if (Object.keys(errs).length) {
      fieldErrors = errs
      return
    }

    saving = true
    try {
      if (editing) {
        // PUT 不接受 aliasType 變更（後端只吃 canonicalName/aliasValue/note/songID）
        const payload = {
          canonicalName,
          aliasValue,
          note: nullIfBlank(form.note),
          songID: form.aliasType === 'title' ? (form.songID ?? null) : null,
        }
        const res = await apiPut(`/api/aliases/${editing.aliasID}`, payload)
        const updated =
          res && typeof res === 'object' && res.aliasID != null ? res : { ...editing, ...payload }
        await aliases.applyLocalUpdate(updated)
      } else {
        const payload = {
          aliasType: form.aliasType,
          canonicalName,
          aliasValue,
          note: nullIfBlank(form.note),
        }
        if (form.aliasType === 'title' && form.songID != null) payload.songID = form.songID

        // quick-add 是 upsert（apiPost 會吃掉信封，故用 request 讀 raw）
        const res = await request('/api/aliases/quick-add', { method: 'POST', body: payload })
        const row = res.data
        // isNew=false ＝ 這筆別名本來就在，這次是「更新既有」而非新增。使用者按的是
        // 「新增」鈕，drawer 靜靜關掉會讓人以為多了一筆、卻在表格裡找不到（其實是某一列
        // 被改掉了）——所以要明講。
        const isNew = res.raw?.isNew !== false
        // 前瞻相容：後端日後若回報「既有別名被改綁到另一首歌」（rebound／previousSongID），
        // 就一併警示。欄位不存在時整條恆為 false，完全不依賴後端先上線。
        const prevSongID = res.raw?.previousSongID
        const rebound =
          res.raw?.rebound === true ||
          (prevSongID != null && prevSongID !== (payload.songID ?? null))

        if (row && typeof row === 'object' && row.aliasID != null) {
          // 本地一律以「這筆 aliasID 在不在」為準（不看 isNew）：
          // 插入重複 key 會讓 {#each} 直接炸，漏插則會讓新別名看不見
          const exists = aliases.rows.some((r) => r.aliasID === row.aliasID)
          if (exists) await aliases.applyLocalUpdate(row)
          else await aliases.applyLocalInsert(row)
        } else {
          await aliases.reload()
        }

        if (!isNew || rebound) {
          showNotice(
            [!isNew && m.aliasUpdated.replace('{v}', aliasValue), rebound && m.aliasRebound]
              .filter(Boolean)
              .join(' '),
            rebound ? 'warn' : 'success',
          )
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
      await apiDelete(`/api/aliases/${editing.aliasID}`)
      await aliases.applyLocalDelete(editing.aliasID)
      deleteOpen = false
      drawerOpen = false
    } catch (err) {
      deleteError = errorText(err)
    } finally {
      deleting = false
    }
  }

  async function runTest() {
    if (testing) return
    const inputText = nullIfBlank(testForm.inputText)
    if (!inputText) return
    testing = true
    testError = ''
    testResult = null
    try {
      testResult = await apiPost('/api/aliases/test', {
        aliasType: testForm.aliasType,
        inputText,
      })
    } catch (err) {
      testError = errorText(err)
    } finally {
      testing = false
    }
  }
</script>

<Page title={t('page.aliases')} {subtitle} wide>
  {#snippet toolbar()}
    <SyncStatus store={aliases} />
  {/snippet}

  <Toolbar>
    <SearchBox
      bind:value={query}
      placeholder={m.searchPlaceholder}
      helpFields={searchHelp.fields}
      helpExamples={searchHelp.examples}
    />
    <FilterChips
      options={typeOptions}
      selected={typeFilter}
      onchange={(next) => (typeFilter = next)}
    />

    {#snippet actions()}
      <Button onclick={openTest}>{m.testButton}</Button>
      <!-- 手機唯讀：條件渲染（CSS hidden 會被 Button 的 inline-flex 蓋掉——鐵則 2） -->
      {#if !isMobile}
        <Button variant="primary" onclick={() => openForm(null)}>
          <span class="text-base leading-none">＋</span>
          {t('common.add')}
        </Button>
      {/if}
      <DownloadMenu rows={view} cols={exportCols} basename="aliases" />
    {/snippet}
  </Toolbar>

  <!-- upsert 的實際結果（更新既有／改綁）：drawer 已關掉，提示留在頁面上 -->
  {#if notice}
    <Alert kind={notice.kind}>{notice.text}</Alert>
  {/if}

  <DataTable
    rows={view}
    columns={tableColumns}
    keyOf={(r) => r.aliasID}
    rowHeight={58}
    mobileRowHeight={100}
    minWidth={820}
    {sort}
    onsort={(s) => (sort = s)}
    columnFilters={colFilters}
    onfilterchange={(next) => (colFilters = next)}
    onedit={openForm}
    loading={aliases.loading}
  >
    {#snippet cell(row, col)}
      {#if col.key === 'aliasType'}
        <span
          class="w-fit rounded-full border px-2.5 py-1 text-sm leading-none"
          style={row.aliasType === 'title'
            ? 'background: var(--berry-subtle-bg); border-color: var(--berry-subtle-border); color: var(--berry-text-emphasis)'
            : 'background: var(--berry-bg-3); border-color: var(--berry-border); color: var(--berry-fg-2)'}
        >
          {typeLabel(row.aliasType)}
        </span>
      {:else if col.key === 'songID'}
        {#if row.songID != null}
          <span class="truncate text-berry-fg-2" title={boundSongName(row) || undefined}>
            {boundSongName(row)}
          </span>
          <span class="truncate font-mono text-sm text-berry-fg-3">#{row.songID}</span>
        {:else}
          <span class="text-sm text-berry-fg-3">{m.unbound}</span>
        {/if}
      {:else if col.key === 'aliasValue'}
        <span class="truncate" title={row.aliasValue || undefined}>{row.aliasValue ?? ''}</span>
      {:else}
        <span class="truncate text-berry-fg-2" title={row[col.key] || undefined}>
          {row[col.key] ?? ''}
        </span>
      {/if}
    {/snippet}

    {#snippet card(row)}
      <div class="flex h-full flex-col justify-center gap-0.5">
        <div class="flex items-center gap-1.5">
          <span
            class="shrink-0 rounded-full border px-2 py-1 text-sm leading-none"
            style={row.aliasType === 'title'
              ? 'background: var(--berry-subtle-bg); border-color: var(--berry-subtle-border); color: var(--berry-text-emphasis)'
              : 'background: var(--berry-bg-3); border-color: var(--berry-border); color: var(--berry-fg-2)'}
          >
            {typeLabel(row.aliasType)}
          </span>
          <span class="truncate text-sm">{row.aliasValue}</span>
        </div>
        <div class="truncate text-sm text-berry-fg-2">→ {row.canonicalName}</div>
        {#if row.note}
          <div class="truncate text-sm text-berry-fg-3">{row.note}</div>
        {/if}
      </div>
    {/snippet}
  </DataTable>
</Page>

<datalist id="alias-artist-suggestions">
  {#each artistSuggestions as a (a)}
    <option value={a}></option>
  {/each}
</datalist>

<Drawer
  open={drawerOpen}
  title={mode === 'test' ? m.testTitle : editing ? m.editTitle : m.addTitle}
  subtitle={mode === 'form' && editing ? `#${editing.aliasID}` : ''}
  focusSeq={drawerSeq}
  onclose={requestClose}
>
  {#key drawerSeq}
    {#if mode === 'test'}
      <p class="mb-3 text-sm text-berry-fg-3">{m.testHint}</p>

      <Field label={t('field.aliasType')}>
        <div class="flex gap-2">
          {#each ['title', 'artist'] as type (type)}
            <button
              type="button"
              class="rounded-md border px-3 py-1.5 text-sm transition-colors"
              style={testForm.aliasType === type
                ? 'background: var(--berry-subtle-bg); border-color: var(--berry-subtle-border); color: var(--berry-text-emphasis)'
                : 'background: var(--berry-bg-3); border-color: var(--berry-border)'}
              onclick={() => (testForm.aliasType = type)}
            >
              {typeLabel(type)}
            </button>
          {/each}
        </div>
      </Field>

      <Field label={m.inputText} forId="alias-test-input">
        <TextInput id="alias-test-input" multiline rows={3} bind:value={testForm.inputText} />
      </Field>

      <Button variant="primary" busy={testing} onclick={runTest}>{m.run}</Button>

      {#if testError}
        <div class="mt-3"><Alert>{testError}</Alert></div>
      {/if}

      {#if testResult}
        <div class="mt-4 border-t border-berry-border pt-3">
          <h3 class="mb-2 text-sm font-medium text-berry-fg-2">
            {m.matches.replace('{n}', String(testResult.matchCount ?? testResult.matches?.length ?? 0))}
          </h3>
          {#if (testResult.matches?.length ?? 0) === 0}
            <p class="text-sm text-berry-fg-3">{m.noMatch}</p>
          {:else}
            <ul class="space-y-2">
              {#each testResult.matches as match (match.canonicalName)}
                <li class="rounded-md border border-berry-border bg-berry-bg-3 px-3 py-2">
                  <div class="text-sm">{match.canonicalName}</div>
                  <div class="mt-1 flex flex-wrap gap-1">
                    {#each match.aliases ?? [] as a (a.value)}
                      <span
                        class="rounded-full border px-2 py-1 text-sm leading-none"
                        style="border-color: var(--berry-subtle-border); color: var(--berry-text-emphasis)"
                        title={a.note ?? ''}
                      >
                        {a.value}
                      </span>
                    {/each}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    {:else}
      {#if formError}
        <Alert>
          {formError}
          {#if formErrorDetail}
            <div class="mt-1 text-sm opacity-70">{formErrorDetail}</div>
          {/if}
        </Alert>
      {/if}

      <Field label={t('field.aliasType')} error={fieldErrors.aliasType}>
        <div class="flex gap-2">
          {#each ['title', 'artist'] as type (type)}
            <button
              type="button"
              class="rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
              disabled={!!editing}
              style={form.aliasType === type
                ? 'background: var(--berry-subtle-bg); border-color: var(--berry-subtle-border); color: var(--berry-text-emphasis)'
                : 'background: var(--berry-bg-3); border-color: var(--berry-border)'}
              onclick={() => {
                form.aliasType = type
                if (type === 'artist') form.songID = null
              }}
            >
              {typeLabel(type)}
            </button>
          {/each}
        </div>
      </Field>

      {#if form.aliasType === 'title'}
        <Field label={m.boundSong} hint={m.boundHint}>
          <Combobox
            options={songOptions}
            value={form.songID}
            placeholder={m.boundSong}
            onselect={onPickSong}
          />
        </Field>
      {/if}

      <Field
        label={t('field.canonicalName')}
        required
        hint={form.aliasType === 'title' ? m.canonicalHint : m.canonicalArtistHint}
        error={fieldErrors.canonicalName}
        forId="alias-canonical"
      >
        <TextInput
          id="alias-canonical"
          bind:value={form.canonicalName}
          maxlength={500}
          invalid={!!fieldErrors.canonicalName}
          list={form.aliasType === 'artist' ? 'alias-artist-suggestions' : undefined}
        />
      </Field>

      <Field
        label={t('field.aliasValue')}
        required
        hint={m.aliasHint}
        error={fieldErrors.aliasValue}
        forId="alias-value"
      >
        <TextInput
          id="alias-value"
          bind:value={form.aliasValue}
          maxlength={500}
          invalid={!!fieldErrors.aliasValue}
        />
      </Field>

      <Field label={t('field.note')} error={fieldErrors.note}>
        <TextInput multiline rows={2} bind:value={form.note} maxlength={500} />
      </Field>
    {/if}
  {/key}

  {#snippet footer()}
    {#if mode === 'test'}
      <div class="flex-1"></div>
      <Button onclick={() => (drawerOpen = false)}>{t('common.close')}</Button>
    {:else}
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
      <Button variant="primary" busy={saving} onclick={requestSave}>{t('common.save')}</Button>
    {/if}
  {/snippet}
</Drawer>

<!-- 歌手正式名稱是自由輸入欄：不在資料庫中的名稱送出前確認一次（軟確認，不阻擋） -->
<ConfirmDialog
  open={newArtistOpen}
  title={m.newArtistTitle}
  message={m.newArtistMessage.replace('{name}', String(form.canonicalName ?? '').trim())}
  confirmLabel={m.newArtistOk}
  onconfirm={save}
  oncancel={() => (newArtistOpen = false)}
/>

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
  message={m.deleteMessage.replace('{name}', editing?.aliasValue ?? '')}
  confirmLabel={t('common.delete')}
  busy={deleting}
  error={deleteError}
  onconfirm={remove}
  oncancel={() => (deleteOpen = false)}
/>
