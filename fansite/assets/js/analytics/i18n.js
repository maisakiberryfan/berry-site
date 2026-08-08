// 分析頁的三語字典（統計面板 ＋ 查詢面板）。
//
// 為什麼不用 data-lang span：面板裡大量內容是 JS 動態產生的（篩選條件列、欄位
// 核取方塊、快速範本、圖表 SVG…），data-lang 需要 tool.js 的 updatePageLang 掃描
// 才會生效，動態節點不在掃描時機內。改語言時 tool.js 會重跑 setContent → 本模組
// 的 initAnalytics 再跑一次，整頁以新語言重建，效果一致。
// analytics.htm 裡的靜態文字仍走 data-lang（由 updatePageLang 處理）。

/** 目前語言：tool.js 掛的 window.berryLang()，取不到時退回 localStorage / 瀏覽器偵測 */
export function getLang() {
  try {
    const fromTool = typeof window.berryLang === 'function' ? window.berryLang() : null
    if (fromTool) return fromTool
    const stored = localStorage.getItem('lang')
    if (stored) return stored
  } catch { /* 隱私模式讀取失敗 */ }
  const nav = navigator.language || ''
  if (nav.startsWith('zh')) return 'zh'
  if (nav.startsWith('ja')) return 'ja'
  return 'en'
}

/** { zh, en, ja } → 目前語言的字串 */
export function pick(obj, lang) {
  return obj?.[lang] ?? obj?.zh ?? ''
}

export const MESSAGES = {
  zh: {
    stat: {
      songs: '曲庫歌曲數',
      performances: '總演唱次數',
      streams: '總場次數',
      karaoke: '歌枠場數',
      songsHint: '收錄曲目總數',
      streamsHint: '直播＋投稿影片'
    },
    top: { title: '演唱次數排行 TOP 20', caption: '依 setlist 出現次數統計' },
    trend: {
      title: '月度趨勢（近 24 個月）',
      caption: '依直播／曲目的時間欄位分月統計',
      streams: '場次數',
      songs: '演唱曲數'
    },
    artist: { title: '歌手排行 TOP 10', caption: '依 setlist 的歌手欄位統計演唱次數' },
    unit: { times: ' 次', streams: ' 場' },
    loading: '載入中…',
    noData: '沒有資料',
    loadFailed: '資料載入失敗',
    retry: '重試',
    /* 查詢面板 */
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
      eq: '等於', contains: '包含', startsWith: '開頭為',
      gt: '大於', lt: '小於', between: '介於', notEmpty: '不為空'
    },
    opDate: {
      eq: '就在這天', gt: '這天（含）之後', lt: '這天（含）之前',
      between: '介於', notEmpty: '有時間'
    },
    aggLabel: {
      count: '筆數', countDistinct: '去重計數', avg: '平均',
      sum: '總和', max: '最大值', min: '最小值'
    },
    valuePlaceholder: '值',
    valueTo: '到',
    columnsHint: '點欄位名可插入編輯器',
    stage: { engine: '載入查詢引擎中…', data: '建立資料表中…', query: '查詢執行中…' },
    resultInfo: (n, ms) => `${n.toLocaleString('en-US')} 筆結果 · ${ms} ms`,
    empty: '查詢成功，但沒有符合條件的資料',
    idle: '設定好條件後按「執行查詢」，結果會顯示在這裡',
    errorTitle: '查詢失敗',
    dataInfo: (n) => `資料 ${n.toLocaleString('en-US')} 筆`,
    saveNamePrompt: '輸入查詢名稱：',
    saveOk: (name) => `已儲存查詢：${name}`,
    saveEmpty: '請先設定查詢內容',
    deleteConfirm: (name) => `確定要刪除查詢「${name}」嗎？`,
    deleteOk: (name) => `已刪除查詢：${name}`,
    loadOk: (name) => `已載入查詢：${name}，執行中…`,
    exportEmpty: '沒有資料可匯出',
    exportOk: (file) => `已匯出檔案：${file}`,
    exportFail: '匯出失敗',
    savedLegacy: '（舊版查詢，已自動轉為建構器範本）'
  },
  en: {
    stat: {
      songs: 'Songs in library',
      performances: 'Total performances',
      streams: 'Streams & videos',
      karaoke: 'Karaoke streams',
      songsHint: 'entries in the song library',
      streamsHint: 'live streams + uploads'
    },
    top: { title: 'Most performed — top 20', caption: 'By number of setlist entries' },
    trend: {
      title: 'Monthly trend (last 24 months)',
      caption: 'Grouped by the time field of streams / setlist entries',
      streams: 'Streams',
      songs: 'Songs performed'
    },
    artist: { title: 'Top artists — top 10', caption: 'Performance count by the artist field of setlist' },
    unit: { times: '', streams: '' },
    loading: 'Loading…',
    noData: 'No data',
    loadFailed: 'Failed to load data',
    retry: 'Try again',
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
      eq: 'is', contains: 'contains', startsWith: 'starts with',
      gt: 'greater than', lt: 'less than', between: 'between', notEmpty: 'is not empty'
    },
    opDate: {
      eq: 'on this day', gt: 'on or after', lt: 'on or before',
      between: 'between', notEmpty: 'has a time'
    },
    aggLabel: {
      count: 'Count', countDistinct: 'Distinct count', avg: 'Average',
      sum: 'Sum', max: 'Maximum', min: 'Minimum'
    },
    valuePlaceholder: 'value',
    valueTo: 'to',
    columnsHint: 'Click a column name to insert it',
    stage: { engine: 'Loading query engine…', data: 'Building the table…', query: 'Running query…' },
    resultInfo: (n, ms) => `${n.toLocaleString('en-US')} rows · ${ms} ms`,
    empty: 'Query succeeded, but returned no rows',
    idle: 'Set up your query and hit Run — results appear here',
    errorTitle: 'Query failed',
    dataInfo: (n) => `${n.toLocaleString('en-US')} rows`,
    saveNamePrompt: 'Enter query name:',
    saveOk: (name) => `Query saved: ${name}`,
    saveEmpty: 'Set up a query first',
    deleteConfirm: (name) => `Delete query "${name}"?`,
    deleteOk: (name) => `Query deleted: ${name}`,
    loadOk: (name) => `Query loaded: ${name}, running…`,
    exportEmpty: 'No data to export',
    exportOk: (file) => `Exported: ${file}`,
    exportFail: 'Export failed',
    savedLegacy: '(legacy query, converted to a builder template)'
  },
  ja: {
    stat: {
      songs: '登録楽曲数',
      performances: '総歌唱回数',
      streams: '配信・動画数',
      karaoke: '歌枠の回数',
      songsHint: '収録楽曲の総数',
      streamsHint: '配信＋投稿動画'
    },
    top: { title: '歌唱回数ランキング TOP 20', caption: 'セットリストの出現回数で集計' },
    trend: {
      title: '月別推移（直近 24 か月）',
      caption: '配信・曲目の時刻フィールドで月ごとに集計',
      streams: '配信・動画数',
      songs: '歌唱曲数'
    },
    artist: { title: 'アーティスト別 TOP 10', caption: 'セットリストのアーティスト欄で集計' },
    unit: { times: ' 回', streams: ' 本' },
    loading: '読み込み中…',
    noData: 'データなし',
    loadFailed: 'データの読み込みに失敗しました',
    retry: '再試行',
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
      eq: 'が次と一致', contains: 'を含む', startsWith: 'で始まる',
      gt: 'が次より大きい', lt: 'が次より小さい', between: 'が次の範囲', notEmpty: 'が空でない'
    },
    opDate: {
      eq: 'がこの日', gt: 'がこの日以降', lt: 'がこの日以前',
      between: 'が次の範囲', notEmpty: 'に時刻がある'
    },
    aggLabel: {
      count: '件数', countDistinct: 'ユニーク数', avg: '平均',
      sum: '合計', max: '最大', min: '最小'
    },
    valuePlaceholder: '値',
    valueTo: '〜',
    columnsHint: 'カラム名をクリックで挿入',
    stage: { engine: 'クエリエンジンを読み込み中…', data: 'テーブルを構築中…', query: 'クエリを実行中…' },
    resultInfo: (n, ms) => `${n.toLocaleString('en-US')} 件 · ${ms} ms`,
    empty: 'クエリは成功しましたが、該当データはありません',
    idle: '条件を設定して「クエリ実行」を押すと、ここに結果が出ます',
    errorTitle: 'クエリ失敗',
    dataInfo: (n) => `データ ${n.toLocaleString('en-US')} 件`,
    saveNamePrompt: 'クエリ名を入力：',
    saveOk: (name) => `クエリを保存しました：${name}`,
    saveEmpty: '先にクエリを設定してください',
    deleteConfirm: (name) => `クエリ「${name}」を削除しますか？`,
    deleteOk: (name) => `クエリを削除しました：${name}`,
    loadOk: (name) => `クエリを読み込みました：${name}、実行中…`,
    exportEmpty: 'エクスポートするデータがありません',
    exportOk: (file) => `エクスポートしました：${file}`,
    exportFail: 'エクスポートに失敗しました',
    savedLegacy: '（旧版クエリ、ビルダーのテンプレートに変換しました）'
  }
}
