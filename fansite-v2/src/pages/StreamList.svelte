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
  import RowMenu from '../lib/table/RowMenu.svelte'
  import KLSetlistDialog from '../lib/table/KLSetlistDialog.svelte'

  import { t, getLang } from '../i18n.svelte.js'
  import { navigate } from '../router.svelte.js'
  import { streamlist, setlist } from '../api/store.svelte.js'
  import { apiGet, apiPost, apiPut, apiDelete } from '../api/client.js'
  import {
    MOBILE_MQ,
    tokenize,
    matchesQuery,
    applySort,
    compileColumnFilters,
    matchesColumnFilters,
    countDistinct,
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
      rowMenu: '更多動作',
      viewSetlist: '查看歌單',
      editSetlist: '新增／編輯歌單',
      copyUrl: '複製網址',
      copyFailed: '複製失敗',
      klSetlist: 'KL 格式歌單',
      klCopyAll: '複製全部',
      klEmpty: '這場尚無歌單資料',
      klFailed: '歌單載入失敗',
      ytLooking: '正在取得影片資訊…',
      ytFailed: '無法取得影片資訊，請手動填寫標題與時間。',
      ytNotFound: '找不到這部影片（ID 可能有誤），請確認後手動填寫。',
      ytNotBerry: '此影片不屬於 berry 的頻道。確認無誤才繼續新增。',
      ytNotBerryConfirm: '仍要新增',
      ytBlocked: '請先確認這部非 berry 頻道的影片，或改貼其他網址。',
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
      rowMenu: 'More actions',
      viewSetlist: 'View set list',
      editSetlist: 'Add / edit set list',
      copyUrl: 'Copy URL',
      copyFailed: 'Copy failed',
      klSetlist: 'KL-format set list',
      klCopyAll: 'Copy all',
      klEmpty: 'No set list for this stream yet',
      klFailed: 'Failed to load the set list',
      ytLooking: 'Fetching video info…',
      ytFailed: 'Could not fetch video info. Please fill in title and time manually.',
      ytNotFound: 'Video not found (check the ID). Please fill in the fields manually.',
      ytNotBerry: 'This video is not from a berry channel. Confirm before adding it.',
      ytNotBerryConfirm: 'Add anyway',
      ytBlocked: 'Confirm this non-berry video first, or paste another URL.',
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
      rowMenu: 'その他の操作',
      viewSetlist: 'セットリストを表示',
      editSetlist: 'セットリストを追加・編集',
      copyUrl: 'URL をコピー',
      copyFailed: 'コピーできませんでした',
      klSetlist: 'KL 形式のセットリスト',
      klCopyAll: 'すべてコピー',
      klEmpty: 'この配信のセットリストはまだありません',
      klFailed: 'セットリストを読み込めませんでした',
      ytLooking: '動画情報を取得中…',
      ytFailed: '動画情報を取得できませんでした。タイトルと時間は手入力してください。',
      ytNotFound: '動画が見つかりません（ID をご確認ください）。手入力してください。',
      ytNotBerry: 'この動画は berry のチャンネルではありません。確認のうえ追加してください。',
      ytNotBerryConfirm: 'それでも追加',
      ytBlocked: 'berry 以外のチャンネルの動画です。確認するか、別の URL を貼ってください。',
    },
  }
  const m = $derived(msgs[getLang()] ?? msgs.zh)

  /* ---------- 表格 ---------- */
  // filterValue：標題欄的儲存格同時顯示 streamID、時間欄顯示格式化後的字串，篩選跟著比同一份
  const columns = $derived([
    { key: 'thumb', label: '', width: '176px', sortable: false, filter: false },
    {
      key: 'title',
      label: t('field.title'),
      width: 'minmax(200px, 2.4fr)',
      filterValue: (r) => `${r.title ?? ''} ${r.streamID ?? ''}`,
    },
    {
      key: 'time',
      label: labelWithTz(t('field.time')),
      width: '176px',
      filterValue: (r) => formatDateTime(r.time),
    },
    {
      key: 'categories',
      label: t('field.categories'),
      width: 'minmax(140px, 1.2fr)',
      sortable: false,
      filter: 'select',
    },
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
  /** 欄位篩選列的值 { 欄key: 值 }（DataTable 只給值，過濾在這裡疊加） */
  let colFilters = $state({})

  /**
   * 先排序、再篩選（四頁共用的作法）：排序結果只依賴「資料 ∧ 排序條件」，$derived 會替它
   * 快取——篩選每變一次（欄位篩選列每敲一鍵）都重排整表的成本因此消失。篩選保序、
   * Array#sort 穩定，輸出序列與「先篩後排」逐列相同。sort 為 null 時 applySort 原樣回傳。
   */
  const sorted = $derived(applySort(streamlist.rows, sort, columns))

  /**
   * 分類 chips：值與排序取全量（選項與順序不隨篩選跳動），
   * 計數 cascade——隨「chips 群以外的全部條件」（全域搜尋 ∧ 欄位篩選）收斂，
   * 與表頭 select 同一套語意，同頁不出現兩套數字。
   */
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

  const categoryOptions = $derived.by(() => {
    const cascade = countDistinct(beforeChips, (r) => r.categories)
    return [...countDistinct(streamlist.rows, (r) => r.categories).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value]) => ({ value, label: value, count: cascade.get(value) ?? 0 }))
  })

  const allCategoryNames = $derived(categoryOptions.map((o) => o.value))

  // 兩段套用：先算「分類欄篩選以外的全部條件」（全域搜尋 ∧ chips ∧ 其他欄位篩選）——
  // 分類 select 的計數以此為基準（cascade：不裁選項，只更新計數）——再補分類 select 本身。
  const beforeCat = $derived.by(() => {
    const tokens = tokenize(query)
    const cats = catFilter
    const active = compileColumnFilters(colFilters, columns, 'categories')
    if (!tokens.length && !cats.length && !active) return sorted
    return sorted.filter((row) => {
      if (cats.length) {
        const rowCats = row.categories ?? []
        if (!cats.some((c) => rowCats.includes(c))) return false
      }
      if (active && !matchesColumnFilters(row, active)) return false
      return !tokens.length || matchesQuery(row, tokens, SEARCH_FIELDS, SEARCH_ALIASES)
    })
  })

  /** 分類欄 select：選項與排序取自全部資料（不裁選項），計數隨其他條件重算 */
  const catSelectOptions = $derived.by(() => {
    const counts = countDistinct(beforeCat, (r) => r.categories)
    return categoryOptions.map((o) => ({ ...o, count: counts.get(o.value) ?? 0 }))
  })

  const view = $derived.by(() => {
    const c = String(colFilters.categories ?? '')
    return c ? beforeCat.filter((row) => (row.categories ?? []).some((x) => String(x) === c)) : beforeCat
  })

  /** 傳給 DataTable 的欄定義：select 的動態選項另外併上去（避免 columns 反向依賴篩選結果） */
  const tableColumns = $derived(
    columns.map((c) => (c.key === 'categories' ? { ...c, filterOptions: catSelectOptions } : c)),
  )

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

  /* ---------- 手機／桌面 ---------- */
  // 用戶裁示 2026-08-08：手機＝查資料、PC＝編輯。編輯類入口（＋新增、選單裡的歌單編輯）
  // 只在桌面出現；斷點與 DataTable 切卡片模式共用同一條 MOBILE_MQ。
  let isMobile = $state(false)
  $effect(() => {
    const mq = window.matchMedia(MOBILE_MQ)
    const apply = () => (isMobile = mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  })

  /* ---------- 列動作選單 ---------- */
  // 原站對「歌枠」類直播有右鍵選單；這裡兩個入口共用：桌面右鍵整列、⋯ 鈕（含手機卡片）。
  const KARAOKE_RE = /歌枠|singing|karaoke/i
  const isKaraoke = (row) => (row.categories ?? []).some((c) => KARAOKE_RE.test(String(c)))

  /** { row, x, y, align, src } | null；src='btn' 讓 ⋯ 鈕能再按一次收起 */
  let menu = $state(null)
  let copied = $state(false)
  let copyFailed = $state(false)
  let copyTimer

  function closeMenu() {
    menu = null
  }

  // 選單一關就把「已複製」狀態歸零，下次開啟不會殘留
  $effect(() => {
    if (menu) return
    clearTimeout(copyTimer)
    copied = false
    copyFailed = false
  })

  $effect(() => () => clearTimeout(copyTimer))

  function openRowMenuFromButton(row, e) {
    if (menu?.row === row && menu.src === 'btn') {
      closeMenu()
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    // 錨在鈕下方、右緣對齊（選單比鈕寬很多，靠右才不會衝出視窗）
    menu = { row, x: r.right, y: r.bottom + 4, align: 'right', src: 'btn' }
  }

  function openRowMenuFromContext(row, e) {
    e.preventDefault()
    menu = { row, x: e.clientX, y: e.clientY, align: 'left', src: 'context' }
  }

  async function copyUrl(row) {
    const url = ytWatchUrl(row.streamID)
    if (!url) return
    let ok = false
    try {
      await navigator.clipboard.writeText(url)
      ok = true
    } catch {
      // 非安全來源／權限被擋時的退路
      try {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        ta.remove()
      } catch {
        ok = false
      }
    }
    copied = ok
    copyFailed = !ok
    // 就地把選項標籤換成「已複製」再收起，比另外做 toast 輕
    clearTimeout(copyTimer)
    copyTimer = setTimeout(closeMenu, 900)
  }

  const menuItems = $derived.by(() => {
    const row = menu?.row
    if (!row) return []
    const out = []
    if (isKaraoke(row)) {
      out.push({
        label: m.viewSetlist,
        onselect: () => navigate(`/setlist?stream=${encodeURIComponent(row.streamID)}`),
      })
      // 編輯類：桌面限定
      if (!isMobile) {
        out.push({
          label: m.editSetlist,
          onselect: () => navigate(`/setlist?add=${encodeURIComponent(row.streamID)}`),
        })
      }
      // KL 格式＝查閱類（核對留言／貼社群用），手機也給
      out.push({ label: m.klSetlist, onselect: () => openKL(row) })
      out.push({ divider: true })
    }
    out.push({
      label: copied ? t('common.copied') : copyFailed ? m.copyFailed : m.copyUrl,
      keepOpen: true, // 標籤要留著顯示結果，稍後自動收起
      onselect: () => copyUrl(row),
    })
    out.push({
      label: m.openYt,
      onselect: () => window.open(ytWatchUrl(row.streamID), '_blank', 'noopener'),
    })
    return out
  })

  /* ---------- KL 格式歌單（唯讀檢視＋複製） ---------- */
  // 原站 formatKLSetlist 的輸出逐字照抄（站主拿去和 YouTube 留言對照／貼社群）：
  //   ♬セトリ/Set List♬
  //   (空行)
  //   00:06:43 ~ 00:09:42 01| 曲名(英名) | 歌手(英名)
  // 時間戳兩者皆有才寫區間，只有 startTime 就單寫；兩者皆無則只有曲序。

  let klOpen = $state(false)
  let klRow = $state(null)
  let klText = $state('')
  let klLoading = $state(false)
  let klError = $state('')
  /** 併發保護：連開兩場時只認最後一次的結果 */
  let klSeq = 0

  const pad2 = (n) => String(n).padStart(2, '0')

  function klHms(v) {
    if (v == null) return ''
    const total = Math.max(0, Math.floor(Number(v)))
    if (!Number.isFinite(total)) return ''
    return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`
  }

  /** 原站 formatSongDisplay：有英文名就括號附註（與本名相同時原站也照括，沿用） */
  function klName(name, nameEn) {
    return nameEn ? `${name ?? ''}(${nameEn})` : (name ?? '')
  }

  function formatKLSetlist(rows) {
    const lines = ['♬セトリ/Set List♬', '']
    for (const row of rows) {
      const trackNo = String(row.trackNo ?? '').padStart(2, '0')
      let timePart = ''
      if (row.startTime != null && row.endTime != null) {
        timePart = `${klHms(row.startTime)} ~ ${klHms(row.endTime)} `
      } else if (row.startTime != null) {
        timePart = `${klHms(row.startTime)} `
      }
      lines.push(
        `${timePart}${trackNo}| ${klName(row.songName, row.songNameEn)} | ${klName(row.artist, row.artistEn)}`,
      )
    }
    return lines.join('\n')
  }

  /**
   * 取單場歌單。
   *
   * ⚠️ 這份輸出是站主拿去對照 YouTube 留言改資料的依據，錯一行就照錯的改——
   * 「看到的一定是最新」優先於「省一次請求」。因此只有在 store 明確保證
   * 「該場所屬月份的快取完整且已校驗」（hasCompleteDataFor）時才吃快取；
   * 其餘一律打單場端點。
   *
   * 舊寫法只看 `setlist.rows.length` 非零就信快取，兩種假象都會中：
   *   · 該月資料已被別處改過而本頁的 store 尚未校驗 → 吐舊版
   *   · 快取缺月／自癒未完成 → 該場一列都撈不到 → 假的「這場尚無歌單資料」
   */
  async function fetchStreamSetlist(row) {
    const streamID = row.streamID
    if (setlist.hasCompleteDataFor(streamID, row.time)) {
      return setlist.rows.filter((r) => r.streamID === streamID)
    }
    const { data } = await apiGet(`/api/setlist?streamID=${encodeURIComponent(streamID)}`)
    return Array.isArray(data) ? data : []
  }

  async function openKL(row) {
    const seq = ++klSeq
    klRow = row
    klText = ''
    klError = ''
    klLoading = true
    klOpen = true
    try {
      const rows = await fetchStreamSetlist(row)
      if (seq !== klSeq) return
      const sorted = [...rows].sort(
        (a, b) => (a.segmentNo ?? 1) - (b.segmentNo ?? 1) || (a.trackNo ?? 0) - (b.trackNo ?? 0),
      )
      klText = sorted.length ? formatKLSetlist(sorted) : ''
    } catch (err) {
      if (seq !== klSeq) return
      klError = `${m.klFailed}：${err?.message || String(err)}`
    } finally {
      if (seq === klSeq) klLoading = false
    }
  }

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

  /* ---------- 新增時自動帶回 YouTube 資訊 ---------- */
  // 原站 fillVedioInfo 的行為：解析出 videoID → GET /api/yt?id= → 帶回標題與開播時間，
  // 並比對 berry 三頻道白名單（同 CLAUDE.md PubSub 節）。非白名單時原站不自動填、
  // 要使用者按「確認」才繼續——這裡沿用同一條線（警告 ＋ 明確確認才解除阻擋）。
  const BERRY_CHANNELS = [
    'UC7A7bGRVdIwo93nqnA3x-OQ',
    'UCBOGwPeBtaPRU59j8jshdjQ',
    'UC2cgr_UtYukapRUt404In-A',
  ]

  let ytLoading = $state(false)
  /** 查不到／查詢失敗的弱提示：不擋手填流程 */
  let ytNotice = $state('')
  /** 非白名單頻道的暫存影片資訊 { id, title, time, channelId }；null＝無此情況 */
  let ytForeign = $state(null)
  let ytConfirmed = $state(false)
  /** 已查過的 ID（同一支只打一次 API） */
  let ytLookupId = ''
  let ytSeq = 0
  /** 使用者手動改過的欄位不被自動回填覆蓋 */
  let touched = $state({ title: false, time: false, categories: false })

  function resetYtLookup() {
    ytSeq++ // 讓進行中的查詢作廢
    ytLoading = false
    ytNotice = ''
    ytForeign = null
    ytConfirmed = false
    ytLookupId = ''
    touched = { title: false, time: false, categories: false }
  }

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
    resetYtLookup()
    drawerSeq++
    drawerOpen = true
  }

  /**
   * 原站 preCategory 的移植：由標題猜分類；只保留資料裡真的存在的分類名（避免造出新分類）。
   *
   * ⚠️ 與 v2 的**刻意差異**：一條都不命中時回 `[]`，v2 回 `['other']`。
   * `other` 是 v2 這個 fallback 自己製造出來的垃圾分類（DB 裡確實存了一批，
   * 與正牌的「その他 / Others」並存）——猜不到就讓站主自己選，不要繼續生產它。
   * 下一手看到這裡與 v2 不同時請勿「修回去」。
   */
  function guessCategories(title) {
    const s = String(title ?? '')
    const low = s.toLowerCase()
    const out = []
    if (s.includes('歌枠')) out.push('歌枠 / Singing')
    if (low.includes('gam')) out.push('ゲーム / Gaming')
    if (low.includes('short')) out.push('ショート / Shorts')
    if (low.includes('歌ってみた')) out.push('歌ってみた動画 / Cover movie')
    if (['xfd', 'オリジナル', 'music video'].some((k) => low.includes(k)))
      out.push('オリジナル曲 / Original Songs')
    if (['chat', 'talk', '雑談'].some((k) => low.includes(k))) out.push('雑談 / Chatting')
    const known = new Set(allCategoryNames)
    return out.filter((c) => known.has(c))
  }

  function applyVideoInfo(info) {
    if (!touched.title && info.title) form.title = info.title
    if (!touched.time && info.time) {
      const local = toDatetimeLocalValue(info.time)
      if (local) form.time = local
    }
    if (!touched.categories && form.categories.length === 0) {
      const guess = guessCategories(info.title)
      if (guess.length) form.categories = guess
    }
    fieldErrors = { ...fieldErrors, title: '', time: '' }
  }

  async function lookupVideo(id) {
    if (editing || !id || !YT_ID_RE.test(id) || id === ytLookupId) return
    ytLookupId = id
    const seq = ++ytSeq
    ytLoading = true
    ytNotice = ''
    ytForeign = null
    ytConfirmed = false
    try {
      // 查詢類：不必等滿 30s／重試 3 輪，查不到就讓使用者手填
      const { data } = await apiGet(`/api/yt?id=${encodeURIComponent(id)}`, {
        retries: 1,
        timeout: 8000,
      })
      if (seq !== ytSeq) return
      // 回應為 YouTube Data API 原始形狀包一層 time：
      //   { items: [{ id, snippet: { title, channelId, publishedAt }, liveStreamingDetails?, time }] }
      //   time = scheduledStartTime ?? publishedAt（後端 getVideoInfo 補的）
      const item = data?.items?.[0]
      if (!item) {
        ytNotice = m.ytNotFound
        return
      }
      const info = {
        id,
        title: item.snippet?.title ?? '',
        time: item.time || item.liveStreamingDetails?.scheduledStartTime || item.snippet?.publishedAt || '',
        channelId: item.snippet?.channelId ?? '',
      }
      if (!BERRY_CHANNELS.includes(info.channelId)) {
        ytForeign = info // 等使用者確認才填入（原站同樣把資料暫存起來）
        return
      }
      applyVideoInfo(info)
    } catch (err) {
      if (seq !== ytSeq) return
      ytNotice = m.ytFailed
    } finally {
      if (seq === ytSeq) ytLoading = false
    }
  }

  function confirmForeign() {
    if (!ytForeign) return
    ytConfirmed = true
    // 先前的「請先確認…」阻擋訊息隨確認一起消失
    if (formError === m.ytBlocked) formError = ''
    applyVideoInfo(ytForeign)
  }

  /** 新增模式：貼上網址即時解析出 streamID，順手把影片資訊帶回來 */
  function onUrlInput() {
    const id = parseYouTubeId(form.url)
    if (id) {
      form.streamID = id
      fieldErrors = { ...fieldErrors, streamID: '' }
      lookupVideo(id)
    }
  }

  /** 直接手打／貼 ID 到影片 ID 欄時也查（離開欄位才查，免得打到一半就打 API） */
  function onStreamIdBlur() {
    if (editing) return
    lookupVideo(String(form.streamID ?? '').trim())
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

    // 非 berry 頻道的影片要先確認過才放行（原站也是確認後才繼續）
    if (!editing && ytForeign && !ytConfirmed) {
      formError = m.ytBlocked
      return
    }

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
      <!-- ＋新增＝編輯類入口，手機不出現（下載是查閱類，兩邊都留） -->
      {#if !isMobile}
        <Button variant="primary" onclick={() => openForm(null)}>
          <span class="text-base leading-none">＋</span>
          {t('common.add')}
        </Button>
      {/if}
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
    columns={tableColumns}
    keyOf={(r) => r.streamID}
    rowHeight={108}
    mobileRowHeight={110}
    minWidth={880}
    {sort}
    onsort={(s) => (sort = s)}
    columnFilters={colFilters}
    onfilterchange={(next) => (colFilters = next)}
    onedit={openForm}
    onrowcontextmenu={openRowMenuFromContext}
    loading={streamlist.loading}
  >
    {#snippet rowActions(row)}
      <button
        type="button"
        data-rowmenu-trigger
        class="rounded p-1.5 text-berry-fg-3 transition-colors hover:text-[var(--berry-primary)]"
        aria-haspopup="menu"
        aria-expanded={menu?.row === row}
        aria-label={m.rowMenu}
        title={m.rowMenu}
        onclick={(e) => openRowMenuFromButton(row, e)}
      >
        <svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
    {/snippet}

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

<!-- 掛在頁面頂層：RowMenu 用 position:fixed，放進表格的 transform 容器會失去視窗座標系 -->
<RowMenu
  open={!!menu}
  x={menu?.x ?? 0}
  y={menu?.y ?? 0}
  align={menu?.align ?? 'left'}
  items={menuItems}
  label={m.rowMenu}
  onclose={closeMenu}
/>

<KLSetlistDialog
  open={klOpen}
  title={m.klSetlist}
  subtitle={klRow ? `${formatDate(klRow.time)} ${klRow.title ?? klRow.streamID}` : ''}
  text={klText}
  loading={klLoading}
  error={klError}
  emptyMessage={m.klEmpty}
  copyLabel={m.klCopyAll}
  copyFailedLabel={m.copyFailed}
  onclose={() => (klOpen = false)}
/>

<Drawer
  open={drawerOpen}
  title={editing ? m.editTitle : m.addTitle}
  subtitle={editing ? editing.streamID : ''}
  focusSeq={drawerSeq}
  onclose={requestClose}
>
  {#key drawerSeq}
    {#if formError}
      <Alert>{formError}</Alert>
    {/if}

    <!-- 非 berry 頻道：警告＋明確確認才解除送出阻擋（確認後才自動帶入標題／時間） -->
    {#if !editing && ytForeign && !ytConfirmed}
      <Alert>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span>⚠️ {m.ytNotBerry}</span>
          <Button size="sm" onclick={confirmForeign}>{m.ytNotBerryConfirm}</Button>
        </div>
      </Alert>
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
        onblur={onStreamIdBlur}
      />
    </Field>

    {#if !editing && (ytLoading || ytNotice)}
      <p class="-mt-2 mb-3.5 text-sm text-berry-fg-3" role="status">
        {ytLoading ? m.ytLooking : ytNotice}
      </p>
    {/if}

    <Field label={t('field.title')} required error={fieldErrors.title} forId="stream-title">
      <TextInput
        id="stream-title"
        bind:value={form.title}
        maxlength={500}
        invalid={!!fieldErrors.title}
        oninput={() => (touched = { ...touched, title: true })}
      />
    </Field>

    <Field label={labelWithTz(m.localTime)} required error={fieldErrors.time} forId="stream-time">
      <TextInput
        id="stream-time"
        type="datetime-local"
        bind:value={form.time}
        invalid={!!fieldErrors.time}
        oninput={() => (touched = { ...touched, time: true })}
      />
    </Field>

    <Field label={t('field.categories')} hint={m.categoriesHint} error={fieldErrors.categories}>
      <TagInput
        tags={form.categories}
        suggestions={allCategoryNames}
        onchange={(next) => {
          form.categories = next
          touched = { ...touched, categories: true }
        }}
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
