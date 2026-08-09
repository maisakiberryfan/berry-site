<script>
  // 歌單（核心頁，資料最大：15k+ 列走虛擬滾動）
  // 編輯＝drawer；新增＝「＋新增場次歌單」批次表單（單一陣列 POST，只算 1 次 rate limit）
  import Page from '../lib/Page.svelte'
  import DataTable from '../lib/table/DataTable.svelte'
  import Drawer from '../lib/table/Drawer.svelte'
  import ConfirmDialog from '../lib/table/ConfirmDialog.svelte'
  import SearchBox from '../lib/table/SearchBox.svelte'
  import Toolbar from '../lib/table/Toolbar.svelte'
  import DownloadMenu from '../lib/table/DownloadMenu.svelte'
  import SyncStatus from '../lib/table/SyncStatus.svelte'
  import Combobox from '../lib/table/Combobox.svelte'
  import Button from '../lib/table/Button.svelte'
  import Field from '../lib/table/Field.svelte'
  import TextInput from '../lib/table/TextInput.svelte'
  import Alert from '../lib/table/Alert.svelte'

  import { t, getLang } from '../i18n.svelte.js'
  import { route, navigate } from '../router.svelte.js'
  import {
    setlist,
    setlistJoined,
    songlist,
    streamlist,
    songIndex,
    streamIndex,
    hydrateSetlistRow,
    safeYTLink,
    buildYTLink,
    createSetlistEntry,
    setlistKeyOf,
  } from '../api/store.svelte.js'
  import { apiPut, apiDelete } from '../api/client.js'
  import {
    MOBILE_MQ,
    tokenize,
    matchesQuery,
    applySort,
    syntaxName,
    labelWithTz,
    fieldErrorMap,
    nullIfBlank,
    formatDate,
    formatDateTime,
    secondsToHms,
    parseHmsToSeconds,
    durationOf,
    parseYouTubeId,
  } from '../lib/table/utils.js'

  songlist.load()
  streamlist.load()
  setlist.load()

  const msgs = {
    zh: {
      searchPlaceholder: '搜尋全部欄位…（歌手:xx 月:2026-07）',
      allMonths: '全部月份',
      noArchive: '不留檔',
      editTitle: '編輯歌單列',
      addTitle: '新增場次歌單',
      deleteTitle: '刪除歌單列',
      deleteMessage: '確定要刪除第 {seg}-{track} 首「{name}」？',
      pickSong: '選擇歌曲',
      pickSongHint: '從歌曲列表搜尋；選定後自動帶入 songID',
      urlLabel: 'YouTube 網址或影片 ID',
      urlHint: '此場次必須已存在於直播列表',
      streamMissing: '直播列表中找不到這場，請先到「直播列表」新增。',
      idInvalid: '無法解析出有效的 YouTube 影片 ID',
      segment: '段落號',
      startTrack: '起始曲序',
      count: '曲數',
      generate: '產生草稿列',
      draftsHint: '逐列選歌後一次送出（單一批次請求）',
      noDrafts: '先填好場次與曲數，再按「產生草稿列」。',
      countRange: '曲數需介於 1～50',
      rateLimited: '寫入太頻繁（每分鐘 30 次上限），請稍候再試。',
      discardTitle: '放棄未儲存的變更？',
      discardMessage: '表單有尚未儲存的修改，關閉後將遺失。',
      discardOk: '關閉不儲存',
      filtered: '篩選後 {n} 筆',
      duration: '時長',
      unmatched: '（未對應歌曲）',
      loadingBig: '歌單資料量大，首次載入需要幾秒…',
      startLabel: '開始時間',
      endLabel: '結束時間',
      timeHint: '影片內時間點，格式 h:mm:ss、m:ss 或秒數；留空＝未知',
      timeInvalid: '格式無效（例：1:23:45、23:45 或 5025）',
      reorderOpen: '調整此段曲序',
      reorderTitle: '調整曲序：{date} 第 {seg} 段',
      reorderHint: '用 ↑ ↓ 或拖曳調整順序，按「儲存順序」一次送出。儲存後曲序會重新編號為 1…N。',
      reorderSave: '儲存順序',
      reorderReset: '還原',
      moveUp: '上移',
      moveDown: '下移',
      wasTrack: '原 {n}',
      reorderSingle: '此段落只有一首曲目，沒有可調整的順序。',
      reorderStale: '此段落已被其他人修改，請重新載入。',
      reorderGone: '此段落已不存在（可能已被刪除）。',
    },
    en: {
      searchPlaceholder: 'Search all columns… (artist:xx month:2026-07)',
      allMonths: 'All months',
      noArchive: 'No archive',
      editTitle: 'Edit set list row',
      addTitle: 'Add set list for a stream',
      deleteTitle: 'Delete set list row',
      deleteMessage: 'Delete track {seg}-{track} “{name}”?',
      pickSong: 'Pick a song',
      pickSongHint: 'Search the song list; songID is filled in automatically.',
      urlLabel: 'YouTube URL or video ID',
      urlHint: 'The stream must already exist in the stream list.',
      streamMissing: 'Stream not found. Add it in “Stream List” first.',
      idInvalid: 'Could not parse a valid YouTube video ID',
      segment: 'Segment',
      startTrack: 'Start track no.',
      count: 'Rows',
      generate: 'Generate draft rows',
      draftsHint: 'Pick songs per row, then submit once (single batch request).',
      noDrafts: 'Fill in the stream and row count, then press “Generate draft rows”.',
      countRange: 'Rows must be between 1 and 50',
      rateLimited: 'Too many writes (30/min limit). Please retry shortly.',
      discardTitle: 'Discard unsaved changes?',
      discardMessage: 'The form has unsaved edits that will be lost.',
      discardOk: 'Close without saving',
      filtered: '{n} filtered',
      duration: 'Length',
      unmatched: '(no song matched)',
      loadingBig: 'Set list is large — the first load takes a few seconds…',
      startLabel: 'Start time',
      endLabel: 'End time',
      timeHint: 'Position in the video: h:mm:ss, m:ss or seconds; blank = unknown',
      timeInvalid: 'Invalid format (e.g. 1:23:45, 23:45 or 5025)',
      reorderOpen: 'Reorder this segment',
      reorderTitle: 'Reorder: {date} segment {seg}',
      reorderHint:
        'Use ↑ ↓ or drag to rearrange, then press “Save order” to submit once. Track numbers are renumbered 1…N on save.',
      reorderSave: 'Save order',
      reorderReset: 'Reset',
      moveUp: 'Move up',
      moveDown: 'Move down',
      wasTrack: 'was {n}',
      reorderSingle: 'This segment has only one track — nothing to reorder.',
      reorderStale: 'This segment was modified by someone else. Please reload.',
      reorderGone: 'This segment no longer exists (it may have been deleted).',
    },
    ja: {
      searchPlaceholder: '全項目を検索…（アーティスト:xx 月:2026-07）',
      allMonths: 'すべての月',
      noArchive: 'アーカイブなし',
      editTitle: 'セットリスト行を編集',
      addTitle: '配信のセットリストを追加',
      deleteTitle: 'セットリスト行を削除',
      deleteMessage: '{seg}-{track} 曲目「{name}」を削除しますか？',
      pickSong: '曲を選択',
      pickSongHint: '曲リストから検索。選ぶと songID が自動で入ります。',
      urlLabel: 'YouTube の URL または動画 ID',
      urlHint: 'その配信が配信リストに登録済みである必要があります',
      streamMissing: '配信リストに見つかりません。先に「配信リスト」で追加してください。',
      idInvalid: '有効な YouTube 動画 ID を取得できませんでした',
      segment: 'セグメント',
      startTrack: '開始曲順',
      count: '曲数',
      generate: '下書き行を作成',
      draftsHint: '各行で曲を選んでから一括送信します（リクエスト1回）',
      noDrafts: '配信と曲数を入力してから「下書き行を作成」を押してください。',
      countRange: '曲数は 1〜50 の範囲で指定してください',
      rateLimited: '書き込みが多すぎます（毎分30回）。少し待って再試行してください。',
      discardTitle: '未保存の変更を破棄しますか？',
      discardMessage: '保存していない編集内容が失われます。',
      discardOk: '保存せずに閉じる',
      filtered: '絞り込み {n} 件',
      duration: '長さ',
      unmatched: '（曲未対応）',
      loadingBig: 'データ量が多いため、初回の読み込みに数秒かかります…',
      startLabel: '開始時間',
      endLabel: '終了時間',
      timeHint: '動画内の位置。h:mm:ss・m:ss・秒数のいずれか。空欄＝不明',
      timeInvalid: '形式が無効です（例：1:23:45、23:45、5025）',
      reorderOpen: 'この区間の曲順を調整',
      reorderTitle: '曲順の調整：{date} 第 {seg} 区間',
      reorderHint:
        '↑ ↓ またはドラッグで並べ替え、「曲順を保存」で一括送信します。保存後は曲順が 1…N に振り直されます。',
      reorderSave: '曲順を保存',
      reorderReset: '元に戻す',
      moveUp: '上へ',
      moveDown: '下へ',
      wasTrack: '元 {n}',
      reorderSingle: 'この区間は 1 曲のみのため、並べ替えできません。',
      reorderStale: 'この区間は他の人に変更されました。再読み込みしてください。',
      reorderGone: 'この区間は存在しません（削除された可能性があります）。',
    },
  }
  const m = $derived(msgs[getLang()] ?? msgs.zh)

  /* ---------- 表格 ---------- */
  const columns = $derived([
    {
      key: 'stream',
      label: labelWithTz(t('field.stream')),
      width: '140px',
      sortValue: (r) => r.time ?? '',
    },
    { key: 'segmentNo', label: t('field.segmentNo'), width: '58px', align: 'center' },
    { key: 'trackNo', label: t('field.trackNo'), width: '74px', align: 'center' },
    { key: 'songName', label: t('field.songName'), width: 'minmax(180px, 2fr)' },
    { key: 'artist', label: t('field.artist'), width: 'minmax(120px, 1.4fr)' },
    { key: 'note', label: t('field.note'), width: 'minmax(110px, 1fr)' },
    {
      key: 'duration',
      label: m.duration,
      width: '92px',
      align: 'right',
      sortValue: (r) =>
        r.startTime != null && r.endTime != null ? Number(r.endTime) - Number(r.startTime) : null,
    },
  ])

  const SEARCH_FIELDS = [
    'songName',
    'songNameEn',
    'artist',
    'artistEn',
    'note',
    'streamTitle',
    'streamID',
    (r) => formatDate(r.time),
  ]

  /** 列的月份 bucket（與月份下拉、後端 %Y-%m 同語意） */
  const monthOf = (r) =>
    typeof r.time === 'string' && r.time.length >= 7 ? r.time.slice(0, 7) : 'none'

  // 欄位限定語法（`歌手:xx 月:2026-07`）的別名表：中／英／日都收，key 一律小寫
  const F_SONG = ['songName', 'songNameEn']
  const F_ARTIST = ['artist', 'artistEn']
  const F_STREAM = ['streamTitle']
  const F_MONTH = [monthOf]
  const SEARCH_ALIASES = {
    曲名: F_SONG,
    song: F_SONG,
    songname: F_SONG,
    歌手: F_ARTIST,
    artist: F_ARTIST,
    アーティスト: F_ARTIST,
    場次: F_STREAM,
    stream: F_STREAM,
    title: F_STREAM,
    タイトル: F_STREAM,
    配信: F_STREAM,
    備註: ['note'],
    note: ['note'],
    メモ: ['note'],
    月: F_MONTH,
    月份: F_MONTH,
    month: F_MONTH,
  }

  const searchHelp = $derived.by(() => {
    const lang = getLang()
    const n = (zh, ja, en) => (lang === 'en' ? en : lang === 'ja' ? ja : zh)
    return {
      fields: [
        { syntax: syntaxName(lang, '曲名', '曲名', 'song'), label: t('field.songName') },
        { syntax: syntaxName(lang, '歌手', 'アーティスト', 'artist'), label: t('field.artist') },
        { syntax: syntaxName(lang, '場次', '配信', 'stream'), label: t('field.stream') },
        { syntax: syntaxName(lang, '備註', 'メモ', 'note'), label: t('field.note') },
        { syntax: syntaxName(lang, '月', '月', 'month'), label: 'YYYY-MM' },
      ],
      // 範例可直接點擊套用，值取自實際資料才不會點下去 0 筆
      examples: [
        `${n('歌手', 'アーティスト', 'artist')}:ヨルシカ ${n('月', '月', 'month')}:2026-08`,
        `${n('曲名', '曲名', 'song')}:"secret base"`,
      ],
    }
  })

  /* ---------- 網址參數（StreamList 的列選單導過來） ----------
     ?stream=<id> 搜尋框預填該 streamID（SEARCH_FIELDS 含 streamID＝篩出該場全部曲目）
     ?add=<id>    直接開「新增場次歌單」批次 drawer 並預填網址欄
     兩者都在套用後把 query 從網址移除（replaceState），避免重整/分享時殘留。
     初值同步取用：SearchBox 的輸入值在 mount 時就定案，等 effect 再塞會慢一拍。 */
  const initialQuery = typeof location === 'undefined' ? null : route.query
  let query = $state(initialQuery?.get('stream') ?? '')
  let month = $state('')
  let sort = $state(null)
  /** 程式化改寫搜尋字串時遞增：SearchBox 內部有 draft 副本，得重建才會跟上 */
  let searchSeq = $state(0)

  /** 月份下拉：70+ 項太長，按年份 optgroup 分組（年降序、月降序） */
  const monthGroups = $derived.by(() => {
    const years = new Map()
    let hasNone = false
    for (const mo of setlist.months) {
      if (mo === 'none') {
        hasNone = true
        continue
      }
      const y = mo.slice(0, 4)
      if (!years.has(y)) years.set(y, [])
      years.get(y).push(mo)
    }
    const list = [...years.entries()].sort((a, b) => b[0].localeCompare(a[0]))
    for (const [, arr] of list) arr.sort((a, b) => b.localeCompare(a))
    return { years: list, hasNone }
  })

  const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  /** optgroup 已標年份，選項只留月（三語各自的寫法） */
  const monthLabel = $derived.by(() => {
    const lang = getLang()
    return (mo) => {
      const n = Number(mo.slice(5, 7))
      if (!Number.isFinite(n) || n < 1 || n > 12) return mo
      if (lang === 'en') return EN_MONTHS[n - 1]
      return lang === 'ja' ? `${n}月` : `${n} 月`
    }
  })

  const filtered = $derived.by(() => {
    const tokens = tokenize(query)
    const mo = month
    const rows = setlistJoined.rows
    if (!tokens.length && !mo) return rows
    const out = []
    for (const row of rows) {
      if (mo && monthOf(row) !== mo) continue
      if (tokens.length && !matchesQuery(row, tokens, SEARCH_FIELDS, SEARCH_ALIASES)) continue
      out.push(row)
    }
    return out
  })

  const view = $derived(applySort(filtered, sort, columns))

  const exportCols = $derived([
    { key: 'streamID', label: t('field.streamID') },
    { key: 'time', label: t('field.time'), value: (r) => formatDateTime(r.time) },
    { key: 'streamTitle', label: t('field.stream') },
    { key: 'segmentNo', label: t('field.segmentNo') },
    { key: 'trackNo', label: t('field.trackNo') },
    { key: 'songID', label: t('field.songID') },
    { key: 'songName', label: t('field.songName') },
    { key: 'songNameEn', label: t('field.songNameEn') },
    { key: 'artist', label: t('field.artist') },
    { key: 'artistEn', label: t('field.artistEn') },
    { key: 'startTime', label: t('field.startTime') },
    { key: 'endTime', label: t('field.endTime') },
    { key: 'note', label: t('field.note') },
    { key: 'YTLink', label: 'YTLink', value: (r) => safeYTLink(r) },
  ])

  const subtitle = $derived(
    t('common.rowCount', { n: setlistJoined.rows.length }) +
      (view.length !== setlistJoined.rows.length
        ? ` · ${m.filtered.replace('{n}', view.length)}`
        : ''),
  )

  /** 選歌下拉用的選項（songlist ~1k 筆） */
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

  /* ---------- 手機／桌面 ---------- */
  // 用戶裁示 2026-08-08：手機＝查資料、PC＝編輯。曲序調整入口只在桌面出現；
  // 斷點與 DataTable 切卡片模式共用同一條 MOBILE_MQ。
  let isMobile = $state(false)
  $effect(() => {
    const mq = window.matchMedia(MOBILE_MQ)
    const apply = () => (isMobile = mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  })

  /* ---------- Drawer 狀態 ---------- */
  let mode = $state(null) // 'edit' | 'batch' | 'reorder'
  let drawerOpen = $state(false)
  let drawerSeq = $state(0)
  let saving = $state(false)
  let formError = $state('')
  let fieldErrors = $state({})

  let discardOpen = $state(false)
  let deleteOpen = $state(false)
  let deleting = $state(false)
  let deleteError = $state('')

  // 編輯模式
  let editing = $state(null)
  let form = $state({ songID: null, note: '' })
  let snapshot = $state('')

  // 批次新增模式
  let batch = $state({ url: '', segmentNo: 1, startTrack: 1, count: 5, drafts: [] })
  let batchSnapshot = $state('')

  // 曲序調整模式（同一個 drawer 換內容）
  /** { streamID, segmentNo, month, date, streamTitle } | null */
  let reorderCtx = $state(null)
  /** 草稿順序：整包替換（$state.raw），元素為 setlist 列 */
  let reorderDraft = $state.raw([])
  /** 進入排序模式時的原始 trackNo 序列，用於 dirty 比對與「原 n」標示 */
  let reorderOriginal = $state.raw([])
  /** 集合不一致（400/409）：顯示「請重新載入」＋重新載入鈕 */
  let reorderStale = $state(false)
  let dragIndex = $state(-1)

  const batchStreamID = $derived(parseYouTubeId(batch.url))
  const batchStream = $derived(batchStreamID ? (streamIndex.map.get(batchStreamID) ?? null) : null)

  const reorderDirty = $derived(
    reorderDraft.length > 0 &&
      reorderDraft.some((r, i) => Number(r.trackNo) !== Number(reorderOriginal[i])),
  )

  const dirty = $derived(
    mode === 'edit' ? JSON.stringify(form) !== snapshot
    : mode === 'reorder' ? reorderDirty
    : JSON.stringify(batch) !== batchSnapshot,
  )

  const reorderTitle = $derived(
    reorderCtx
      ? m.reorderTitle
          .replace('{date}', reorderCtx.date)
          .replace('{seg}', String(reorderCtx.segmentNo))
      : m.reorderTitle,
  )

  /** 編輯中這一列所屬段落的曲數（<2 時沒有可調整的順序） */
  const editingSegmentSize = $derived.by(() => {
    if (!editing) return 0
    const seg = editing.segmentNo ?? 1
    let n = 0
    for (const r of setlist.rows) {
      if (r.streamID === editing.streamID && (r.segmentNo ?? 1) === seg) n++
    }
    return n
  })

  function openEdit(row) {
    mode = 'edit'
    editing = row
    form = {
      songID: row.songID ?? null,
      note: row.note ?? '',
      startTime: row.startTime != null ? secondsToHms(row.startTime) : '',
      endTime: row.endTime != null ? secondsToHms(row.endTime) : '',
    }
    snapshot = JSON.stringify(form)
    formError = ''
    fieldErrors = {}
    deleteError = ''
    drawerSeq++
    drawerOpen = true
  }

  /** @param {string|null} prefillId 預填的 streamID（?add= 導過來時用） */
  function openBatch(prefillId = null) {
    mode = 'batch'
    editing = null
    // url 欄吃裸 ID（parseYouTubeId 同時支援 ID 與網址），填進去即觸發既有的解析／場次驗證
    batch = { url: prefillId ?? '', segmentNo: 1, startTrack: 1, count: 5, drafts: [] }
    batchSnapshot = JSON.stringify(batch)
    formError = ''
    fieldErrors = {}
    drawerSeq++
    drawerOpen = true
  }

  /**
   * 套用網址參數並把它清掉。
   * 已套過的簽章記下來：replaceState 後 route.query 會再變一次，不能又跑一遍。
   */
  let appliedParams = ''
  $effect(() => {
    const q = route.query
    const stream = q.get('stream')
    const add = q.get('add')
    if (!stream && !add) return
    const sig = `${stream ?? ''}|${add ?? ''}`
    if (sig === appliedParams) return
    appliedParams = sig

    if (stream) {
      query = stream
      month = '' // 月份篩選會與單場搜尋互斥，先清掉
      searchSeq++
    }
    if (add) openBatch(add)

    navigate(location.pathname, { replace: true, scroll: false })
  })

  /** 確認放棄後要做什麼：關掉 drawer，或切進排序模式（編輯表單有未存變更時） */
  let discardAction = $state('close')

  function requestClose() {
    if (saving) return
    if (dirty) {
      discardAction = 'close'
      discardOpen = true
      return
    }
    drawerOpen = false
  }

  function forceClose() {
    discardOpen = false
    if (discardAction === 'reorder') enterReorder()
    else drawerOpen = false
  }

  /* ---------- 曲序調整 ---------- */
  /** 取某段落的全部列（依 trackNo 升序）；setlist VIEW 已含 songName/artist，不需 join */
  function segmentRows(streamID, segmentNo) {
    return setlist.rows
      .filter((r) => r.streamID === streamID && (r.segmentNo ?? 1) === segmentNo)
      .sort((a, b) => Number(a.trackNo) - Number(b.trackNo))
  }

  /** 從編輯 drawer 切進排序模式；表單有未存變更時先問要不要放棄 */
  function requestReorder() {
    if (saving || !editing) return
    if (dirty) {
      discardAction = 'reorder'
      discardOpen = true
      return
    }
    enterReorder()
  }

  function enterReorder() {
    if (!editing) return
    const streamID = editing.streamID
    const segmentNo = editing.segmentNo ?? 1
    reorderCtx = {
      streamID,
      segmentNo,
      month: monthOf(editing), // refreshMonth 用；不留檔場＝'none' bucket
      date: editing.time ? formatDate(editing.time) : m.noArchive,
      streamTitle: editing.streamTitle ?? streamID,
    }
    const list = segmentRows(streamID, segmentNo)
    reorderDraft = list
    reorderOriginal = list.map((r) => Number(r.trackNo))
    reorderStale = false
    dragIndex = -1
    formError = ''
    fieldErrors = {}
    mode = 'reorder'
    drawerSeq++
  }

  function resetReorder() {
    if (!reorderCtx) return
    const byTrack = new Map(reorderDraft.map((r) => [Number(r.trackNo), r]))
    reorderDraft = reorderOriginal.map((t) => byTrack.get(t)).filter(Boolean)
    dragIndex = -1
  }

  /** ↑ ↓：只動本地草稿，不打 API */
  function moveRow(i, delta) {
    const j = i + delta
    if (j < 0 || j >= reorderDraft.length) return
    const next = [...reorderDraft]
    ;[next[i], next[j]] = [next[j], next[i]]
    reorderDraft = next
  }

  /* HTML5 拖曳排序（盡力而為，↑↓ 是保底） */
  function onDragStart(i, e) {
    dragIndex = i
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      // Firefox 沒有 setData 就不會啟動拖曳
      try {
        e.dataTransfer.setData('text/plain', String(i))
      } catch {
        /* 某些瀏覽器在 dragstart 外會擋，忽略即可 */
      }
    }
  }

  function onDragOver(i, e) {
    if (dragIndex < 0) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    if (dragIndex === i) return
    const next = [...reorderDraft]
    const [item] = next.splice(dragIndex, 1)
    next.splice(i, 0, item)
    reorderDraft = next
    dragIndex = i
  }

  async function saveReorder() {
    if (saving || !reorderCtx || !reorderDirty) return
    saving = true
    formError = ''
    fieldErrors = {}
    reorderStale = false
    try {
      await apiPut(
        `/api/setlist/${encodeURIComponent(reorderCtx.streamID)}/${reorderCtx.segmentNo}/reorder`,
        { order: reorderDraft.map((r) => Number(r.trackNo)) },
      )
      // trackNo 被重編為 1..N，composite key 全變 → 逐列 applyLocal 不可行，整月重抓
      await setlist.refreshMonth(reorderCtx.month)
      drawerOpen = false
    } catch (err) {
      // 400（集合不一致）／409（重寫途中段落被改）都是「別人動過了」
      if (err?.status === 400 || err?.status === 409) {
        reorderStale = true
        formError = m.reorderStale
      } else {
        handleError(err)
      }
    } finally {
      saving = false
    }
  }

  /** 衝突後的「重新載入」：重抓該月 → 用新資料重建草稿 */
  async function reloadSegment() {
    if (!reorderCtx || saving) return
    saving = true
    try {
      await setlist.refreshMonth(reorderCtx.month)
      const list = segmentRows(reorderCtx.streamID, reorderCtx.segmentNo)
      if (!list.length) {
        formError = m.reorderGone
        reorderDraft = []
        reorderOriginal = []
        return
      }
      reorderDraft = list
      reorderOriginal = list.map((r) => Number(r.trackNo))
      reorderStale = false
      formError = ''
    } catch (err) {
      handleError(err)
    } finally {
      saving = false
    }
  }

  function handleError(err) {
    fieldErrors = fieldErrorMap(err)
    formError = err?.status === 429 ? m.rateLimited : err?.message || String(err)
  }

  /* ---------- 編輯：PUT composite key ---------- */
  async function save() {
    if (saving || !editing) return
    saving = true
    formError = ''
    fieldErrors = {}
    try {
      const note = nullIfBlank(form.note)
      const seg = editing.segmentNo ?? 1

      // 開始/結束時間：h:mm:ss / m:ss / 秒 → 秒；空＝null；無效擋在前端
      const startTime = parseHmsToSeconds(form.startTime)
      const endTime = parseHmsToSeconds(form.endTime)
      const timeErrs = {}
      if (Number.isNaN(startTime)) timeErrs.startTime = m.timeInvalid
      if (Number.isNaN(endTime)) timeErrs.endTime = m.timeInvalid
      if (Object.keys(timeErrs).length) {
        fieldErrors = timeErrs
        return
      }

      await apiPut(
        `/api/setlist/${encodeURIComponent(editing.streamID)}/${seg}/${editing.trackNo}`,
        { songID: form.songID ?? null, note, startTime, endTime },
      )
      // 回應可能是 setlist_ori 原始 row（缺 join 欄位），本地自行組 VIEW 形狀
      const song = form.songID != null ? songIndex.map.get(form.songID) : null
      await setlist.applyLocalUpdate({
        streamID: editing.streamID,
        segmentNo: seg,
        trackNo: editing.trackNo,
        songID: form.songID ?? null,
        note,
        startTime,
        endTime,
        YTLink: buildYTLink(editing.streamID, startTime),
        songName: song?.songName ?? null,
        songNameEn: song?.songNameEn ?? null,
        artist: song?.artist ?? null,
        artistEn: song?.artistEn ?? null,
      })
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
      const seg = editing.segmentNo ?? 1
      await apiDelete(
        `/api/setlist/${encodeURIComponent(editing.streamID)}/${seg}/${editing.trackNo}`,
      )
      await setlist.applyLocalDelete(editing)
      deleteOpen = false
      drawerOpen = false
    } catch (err) {
      deleteError = err?.status === 429 ? m.rateLimited : err?.message || String(err)
    } finally {
      deleting = false
    }
  }

  /* ---------- 批次新增 ---------- */
  /** 建議起始曲序：該場該段既有最大 trackNo + 1 */
  const suggestedStart = $derived.by(() => {
    if (!batchStreamID) return 1
    const seg = Number(batch.segmentNo) || 1
    let max = 0
    for (const r of setlist.rows) {
      if (r.streamID !== batchStreamID) continue
      if ((r.segmentNo ?? 1) !== seg) continue
      if (Number(r.trackNo) > max) max = Number(r.trackNo)
    }
    return max + 1
  })

  let lastSuggestKey = ''
  $effect(() => {
    const key = `${batchStreamID ?? ''}/${batch.segmentNo}`
    if (key === lastSuggestKey) return
    lastSuggestKey = key
    if (batchStreamID) batch.startTrack = suggestedStart
  })

  function generateDrafts() {
    fieldErrors = {}
    const n = Number(batch.count)
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      fieldErrors = { count: m.countRange }
      return
    }
    const start = Number(batch.startTrack) || 1
    batch.drafts = Array.from({ length: n }, (_, i) => ({
      trackNo: start + i,
      songID: null,
      note: '',
    }))
  }

  async function submitBatch() {
    if (saving) return
    formError = ''
    fieldErrors = {}

    if (!batchStreamID) {
      fieldErrors = { url: m.idInvalid }
      return
    }
    if (!batchStream) {
      formError = m.streamMissing
      return
    }
    if (!batch.drafts.length) {
      formError = m.noDrafts
      return
    }

    const seg = Number(batch.segmentNo) || 1
    const payload = batch.drafts.map((d) => {
      const item = { streamID: batchStreamID, segmentNo: seg, trackNo: Number(d.trackNo) }
      if (d.songID != null) item.songID = d.songID
      const note = nullIfBlank(d.note)
      if (note) item.note = note
      return item
    })

    saving = true
    try {
      // 陣列一次送出（≤200）＝ rate limit 只算 1 次
      const res = await createSetlistEntry(payload)

      let created = null
      if (Array.isArray(res)) created = res
      else if (res && typeof res === 'object') {
        if (Array.isArray(res.created)) created = res.created
        else if (Array.isArray(res.rows)) created = res.rows
        else if (res.streamID) created = [res]
      }

      const existing = new Set(setlist.rows.map((r) => setlistKeyOf(r)))
      for (const ori of created ?? payload) {
        const row = hydrateSetlistRow(ori)
        if (existing.has(setlistKeyOf(row))) await setlist.applyLocalUpdate(row)
        else await setlist.applyLocalInsert(row)
      }
      drawerOpen = false
    } catch (err) {
      handleError(err)
    } finally {
      saving = false
    }
  }
</script>

<Page title={t('page.setlist')} {subtitle} wide>
  {#snippet toolbar()}
    <SyncStatus store={setlist} />
  {/snippet}

  <Toolbar>
    <!-- key：SearchBox 保有自己的 draft，程式化改寫 query 時要重建才會顯示新值 -->
    {#key searchSeq}
      <SearchBox
        bind:value={query}
        placeholder={m.searchPlaceholder}
        helpFields={searchHelp.fields}
        helpExamples={searchHelp.examples}
      />
    {/key}

    <select
      class="rounded-md border border-berry-border bg-berry-bg-3 px-2 py-1.5 text-sm text-berry-fg outline-none focus:border-[var(--berry-primary)]"
      aria-label={t('field.time')}
      bind:value={month}
    >
      <option value="">{m.allMonths}</option>
      {#if monthGroups.hasNone}
        <option value="none">{m.noArchive}</option>
      {/if}
      {#each monthGroups.years as [year, list] (year)}
        <optgroup label={year}>
          {#each list as mo (mo)}
            <option value={mo}>{monthLabel(mo)}</option>
          {/each}
        </optgroup>
      {/each}
    </select>

    {#snippet actions()}
      <Button variant="primary" class="hidden md:inline-flex" onclick={() => openBatch()}>
        <span class="text-base leading-none">＋</span>
        {t('common.add')}
      </Button>
      <DownloadMenu rows={view} cols={exportCols} basename="setlist" />
    {/snippet}
  </Toolbar>

  <DataTable
    rows={view}
    {columns}
    keyOf={(r) => setlistKeyOf(r)}
    rowHeight={64}
    mobileRowHeight={110}
    minWidth={960}
    {sort}
    onsort={(s) => (sort = s)}
    onedit={openEdit}
    loading={setlist.loading}
    loadingText={m.loadingBig}
  >
    {#snippet cell(row, col)}
      {#if col.key === 'stream'}
        {@const link = safeYTLink(row)}
        {#if link}
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            class="truncate no-underline tabular-nums hover:underline"
            title={row.streamTitle || undefined}
          >
            {row.time ? formatDate(row.time) : m.noArchive}
          </a>
        {:else}
          <span class="truncate tabular-nums" title={row.streamTitle || undefined}>
            {row.time ? formatDate(row.time) : m.noArchive}
          </span>
        {/if}
      {:else if col.key === 'segmentNo'}
        <span class="text-berry-fg-3 tabular-nums">{row.segmentNo ?? 1}</span>
      {:else if col.key === 'trackNo'}
        <span class="text-berry-fg-2 tabular-nums">{row.trackNo}</span>
      {:else if col.key === 'songName'}
        <span class="truncate" title={row.songName || undefined}>{row.songName ?? m.unmatched}</span>
        {#if row.songNameEn}
          <span class="truncate text-sm text-berry-fg-3" title={row.songNameEn}>{row.songNameEn}</span>
        {/if}
      {:else if col.key === 'artist'}
        <span class="truncate text-berry-fg-2" title={row.artist || undefined}>{row.artist ?? ''}</span>
        {#if row.artistEn}
          <span class="truncate text-sm text-berry-fg-3" title={row.artistEn}>{row.artistEn}</span>
        {/if}
      {:else if col.key === 'duration'}
        <span class="truncate text-sm text-berry-fg-3 tabular-nums">
          {durationOf(row.startTime, row.endTime)}
        </span>
      {:else}
        <span class="truncate text-berry-fg-2" title={row[col.key] || undefined}>
          {row[col.key] ?? ''}
        </span>
      {/if}
    {/snippet}

    {#snippet card(row)}
      <div class="flex h-full flex-col justify-center gap-0.5">
        <div class="truncate text-sm">
          <span class="text-berry-fg-3 tabular-nums">{row.segmentNo ?? 1}-{row.trackNo}</span>
          <span class="ml-1.5">{row.songName ?? m.unmatched}</span>
        </div>
        {#if row.artist}
          <div class="truncate text-sm text-berry-fg-2">{row.artist}</div>
        {/if}
        <div class="truncate text-sm text-berry-fg-3 tabular-nums">
          {row.time ? formatDate(row.time) : m.noArchive}
          {#if row.streamTitle}· {row.streamTitle}{/if}
        </div>
      </div>
    {/snippet}
  </DataTable>
</Page>

<Drawer
  open={drawerOpen}
  title={mode === 'edit' ? m.editTitle : mode === 'reorder' ? reorderTitle : m.addTitle}
  subtitle={mode === 'edit' && editing
    ? `${editing.streamID} · ${editing.segmentNo ?? 1}-${editing.trackNo}`
    : mode === 'reorder' && reorderCtx
      ? reorderCtx.streamTitle
      : ''}
  width={mode === 'batch' ? '620px' : mode === 'reorder' ? '520px' : '460px'}
  onclose={requestClose}
>
  {#key drawerSeq}
    {#if formError}
      <Alert>
        {formError}
        {#if reorderStale}
          <div class="mt-2">
            <Button onclick={reloadSegment} disabled={saving}>{t('common.reload')}</Button>
          </div>
        {/if}
      </Alert>
    {/if}

    {#if mode === 'edit' && editing}
      <div class="mb-4 rounded-md border border-berry-border bg-berry-bg-3 px-3 py-2 text-sm text-berry-fg-2">
        <div class="truncate">{editing.streamTitle ?? editing.streamID}</div>
        <div class="mt-0.5 text-berry-fg-3 tabular-nums">
          {editing.time ? formatDateTime(editing.time) : m.noArchive}
          {#if editing.startTime != null}
            · {secondsToHms(editing.startTime)}{#if editing.endTime != null}–{secondsToHms(editing.endTime)}{/if}
          {/if}
        </div>
      </div>

      <Field label={m.pickSong} hint={m.pickSongHint} error={fieldErrors.songID}>
        <Combobox
          options={songOptions}
          value={form.songID}
          invalid={!!fieldErrors.songID}
          placeholder={m.pickSong}
          onselect={(o) => (form.songID = o ? o.id : null)}
        />
      </Field>

      <div class="grid grid-cols-2 gap-3">
        <Field label={m.startLabel} error={fieldErrors.startTime} forId="setlist-start">
          <TextInput
            id="setlist-start"
            bind:value={form.startTime}
            placeholder="1:23:45"
            invalid={!!fieldErrors.startTime}
          />
        </Field>
        <Field label={m.endLabel} error={fieldErrors.endTime} forId="setlist-end">
          <TextInput
            id="setlist-end"
            bind:value={form.endTime}
            placeholder="1:27:30"
            invalid={!!fieldErrors.endTime}
          />
        </Field>
      </div>
      <p class="-mt-2 mb-3.5 text-sm text-berry-fg-3">{m.timeHint}</p>

      <Field label={t('field.note')} error={fieldErrors.note}>
        <TextInput multiline rows={3} bind:value={form.note} maxlength={1000} />
      </Field>
    {:else if mode === 'batch'}
      <Field label={m.urlLabel} hint={m.urlHint} error={fieldErrors.url} forId="setlist-url">
        <TextInput
          id="setlist-url"
          bind:value={batch.url}
          placeholder="https://www.youtube.com/watch?v=…"
          invalid={!!fieldErrors.url}
        />
      </Field>

      {#if batchStreamID}
        <div class="mb-3.5 rounded-md border px-3 py-2 text-sm"
          style={batchStream
            ? 'border-color: var(--berry-border); background: var(--berry-bg-3); color: var(--berry-fg-2)'
            : 'border-color: var(--berry-subtle-border); background: var(--berry-subtle-bg); color: var(--berry-text-emphasis)'}
        >
          <span class="font-mono">{batchStreamID}</span>
          {#if batchStream}
            <div class="mt-0.5 truncate">{batchStream.title}</div>
            <div class="text-berry-fg-3 tabular-nums">{formatDateTime(batchStream.time)}</div>
          {:else}
            <div class="mt-0.5">{m.streamMissing}</div>
          {/if}
        </div>
      {/if}

      <div class="grid grid-cols-3 gap-3">
        <Field label={m.segment} forId="setlist-seg">
          <TextInput id="setlist-seg" type="number" min="1" bind:value={batch.segmentNo} />
        </Field>
        <Field label={m.startTrack} forId="setlist-start">
          <TextInput id="setlist-start" type="number" min="1" bind:value={batch.startTrack} />
        </Field>
        <Field label={m.count} error={fieldErrors.count} forId="setlist-count">
          <TextInput
            id="setlist-count"
            type="number"
            min="1"
            max="50"
            bind:value={batch.count}
            invalid={!!fieldErrors.count}
          />
        </Field>
      </div>

      <div class="mb-4 flex items-center gap-2">
        <Button onclick={generateDrafts} disabled={!batchStream}>{m.generate}</Button>
        <span class="text-sm text-berry-fg-3">{m.draftsHint}</span>
      </div>

      {#if batch.drafts.length}
        <div class="space-y-2 border-t border-berry-border pt-3">
          {#each batch.drafts as draft, i (i)}
            <div class="flex items-start gap-2">
              <span class="w-8 shrink-0 pt-2 text-right text-sm text-berry-fg-3 tabular-nums">
                {draft.trackNo}
              </span>
              <div class="min-w-0 flex-1">
                <Combobox
                  options={songOptions}
                  value={draft.songID}
                  placeholder={m.pickSong}
                  onselect={(o) => (batch.drafts[i].songID = o ? o.id : null)}
                />
              </div>
              <div class="w-32 shrink-0">
                <TextInput bind:value={batch.drafts[i].note} placeholder={t('field.note')} maxlength={1000} />
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <p class="text-sm text-berry-fg-3">{m.noDrafts}</p>
      {/if}
    {:else if mode === 'reorder'}
      <p class="mb-3 text-sm text-berry-fg-3">{m.reorderHint}</p>

      {#if reorderDraft.length <= 1}
        <p class="text-sm text-berry-fg-3">{m.reorderSingle}</p>
      {:else}
        <!-- keyed each：拖曳/上下移時保留節點，焦點才不會掉 -->
        <ul class="space-y-1.5">
          {#each reorderDraft as row, i (setlistKeyOf(row))}
            {@const moved = Number(row.trackNo) !== Number(reorderOriginal[i])}
            <li
              draggable="true"
              ondragstart={(e) => onDragStart(i, e)}
              ondragover={(e) => onDragOver(i, e)}
              ondragend={() => (dragIndex = -1)}
              ondrop={(e) => {
                e.preventDefault()
                dragIndex = -1
              }}
              class="flex items-center gap-2 rounded-md border px-2 py-1.5 {dragIndex === i
                ? 'opacity-60'
                : ''}"
              style={moved
                ? 'border-color: var(--berry-subtle-border); background: var(--berry-subtle-bg)'
                : 'border-color: var(--berry-border); background: var(--berry-bg-3)'}
            >
              <span class="cursor-grab select-none text-berry-fg-3" aria-hidden="true">⠿</span>
              <span
                class="w-6 shrink-0 text-right text-sm font-medium tabular-nums"
                style={moved ? 'color: var(--berry-text-emphasis)' : ''}
              >
                {i + 1}
              </span>

              <div class="min-w-0 flex-1">
                <div class="truncate text-sm" title={row.songName || undefined}>
                  {row.songName ?? m.unmatched}
                </div>
                {#if row.artist}
                  <div class="truncate text-sm text-berry-fg-3" title={row.artist}>{row.artist}</div>
                {/if}
              </div>

              {#if moved}
                <span class="shrink-0 text-sm tabular-nums" style="color: var(--berry-text-emphasis)">
                  {m.wasTrack.replace('{n}', String(row.trackNo))}
                </span>
              {/if}

              <div class="flex shrink-0 items-center gap-1">
                <Button
                  size="icon"
                  ariaLabel={m.moveUp}
                  title={m.moveUp}
                  disabled={i === 0}
                  onclick={() => moveRow(i, -1)}
                >
                  <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </Button>
                <Button
                  size="icon"
                  ariaLabel={m.moveDown}
                  title={m.moveDown}
                  disabled={i === reorderDraft.length - 1}
                  onclick={() => moveRow(i, 1)}
                >
                  <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M12 5v14M5 12l7 7 7-7" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </Button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {/key}

  {#snippet footer()}
    {#if mode === 'edit'}
      <Button
        variant="danger"
        onclick={() => {
          deleteError = ''
          deleteOpen = true
        }}
      >
        {t('common.delete')}
      </Button>
      <!-- 手機唯讀裁示：曲序調整只在桌面出現 -->
      {#if !isMobile && editingSegmentSize > 1}
        <Button onclick={requestReorder} disabled={saving}>{m.reorderOpen}</Button>
      {/if}
    {:else if mode === 'reorder'}
      <Button onclick={resetReorder} disabled={saving || !reorderDirty}>{m.reorderReset}</Button>
    {/if}
    <div class="flex-1"></div>
    <Button onclick={requestClose} disabled={saving}>{t('common.cancel')}</Button>
    {#if mode === 'edit'}
      <Button variant="primary" busy={saving} onclick={save}>{t('common.save')}</Button>
    {:else if mode === 'reorder'}
      <Button variant="primary" busy={saving} disabled={!reorderDirty} onclick={saveReorder}>
        {m.reorderSave}
      </Button>
    {:else}
      <Button
        variant="primary"
        busy={saving}
        disabled={!batch.drafts.length || !batchStream}
        onclick={submitBatch}
      >
        {t('common.save')}
      </Button>
    {/if}
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
  message={m.deleteMessage
    .replace('{seg}', String(editing?.segmentNo ?? 1))
    .replace('{track}', String(editing?.trackNo ?? ''))
    .replace('{name}', editing?.songName ?? '')}
  confirmLabel={t('common.delete')}
  busy={deleting}
  error={deleteError}
  onconfirm={remove}
  oncancel={() => (deleteOpen = false)}
/>
