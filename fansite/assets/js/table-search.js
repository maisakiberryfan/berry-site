/**
 * 表格快速搜尋語法（`欄位:值`）——自 fansite-v2（v3 重寫版）移植
 *
 * 來源：fansite-v2 `src/lib/table/utils.js` 的 tokenize / buildHaystack / matchesQuery。
 * 三支純函式的語意原樣保留，欄位別名表改對齊 v2 四張 Tabulator 表的實際欄位。
 *
 * 語法（輸入框 placeholder 與「?」說明面板即提示）：
 *   苺咲 アニソン        空白分隔＝AND 全文
 *   "hello world"        引號括住含空白的詞
 *   歌手:苺咲べりぃ       欄位限定（別名表三語都收）
 *   歌手:"苺咲 べりぃ"    欄位限定＋含空白的值
 *   備註:*               該欄不為空
 *
 * 全形冒號「：」、全形空白與彎引號「“ ”」一併吃（中日輸入法常態）。
 * 欄位名比不到別名表時，**整個 token（含冒號）退回當全文詞**——時間「12:34」不會被誤拆，
 * 這是本語法能安全塞進通用搜尋框的關鍵。
 *
 * ⚠️ v2 專屬：欄位取值對象是 **Tabulator 的列資料**（已過 mutator）。
 *   setlist / streamlist 的 `time` 在 colDef 被 mutator 轉成 'YYYY/MM/DD HH:mm' 本地字串，
 *   不再是 ISO；不留檔場（time 為 null）會被 dayjs 轉成 'Invalid Date'。日期相關的取值
 *   一律走 dateText()，兩種格式都比得到、'Invalid Date' 視為空。
 */

/* ========================= tokenizer ========================= */

const SPACE_RE = /[\s　]/
const QUOTE_RE = /["“”]/
const COLON_RE = /[:：]/

/**
 * 從 i 讀一段文字：遇（未被引號包住的）空白停；stopAtColon 時遇冒號也停。
 * 引號內的空白／冒號視為一般字元。
 */
function readChunk(s, i, stopAtColon) {
  let text = ''
  let quoted = false
  while (i < s.length) {
    const ch = s[i]
    if (QUOTE_RE.test(ch)) {
      quoted = true
      i++
      while (i < s.length && !QUOTE_RE.test(s[i])) text += s[i++]
      if (i < s.length) i++ // 收尾引號（沒有也算讀完）
      continue
    }
    if (SPACE_RE.test(ch)) break
    if (stopAtColon && COLON_RE.test(ch)) break
    text += ch
    i++
  }
  return { text, next: i, quoted }
}

/**
 * 查詢字串切成 token（AND 語意）。
 * @returns {{field: string|null, value: string, raw: string}[]}
 *   field 為 null＝全文詞；raw 為欄位別名比不到時的全文 fallback 用字（含冒號）。
 */
export function tokenize(q) {
  const s = String(q ?? '')
  const out = []
  let i = 0
  while (i < s.length) {
    if (SPACE_RE.test(s[i])) {
      i++
      continue
    }
    const head = readChunk(s, i, true)
    i = head.next

    let field = null
    let value = head.text
    let raw = head.text

    if (!head.quoted && i < s.length && COLON_RE.test(s[i])) {
      const tail = readChunk(s, i + 1, false)
      i = tail.next
      raw = `${head.text}:${tail.text}`
      // 冒號在最前面（":abc"）＝沒有欄位名，整串當全文
      if (head.text) {
        field = head.text.toLowerCase()
        value = tail.text
      } else {
        value = raw
      }
    }

    if (field) {
      // 「歌手:」打到一半＝還沒有值，先不套用條件（否則會瞬間變 0 筆）
      if (value) out.push({ field, value: value.toLowerCase(), raw: raw.toLowerCase() })
    } else if (raw) {
      out.push({ field: null, value: raw.toLowerCase(), raw: raw.toLowerCase() })
    }
  }
  return out
}

/**
 * 由列組出小寫 haystack。
 * fields 元素可為欄位名字串，或 (row) => any 的取值函式（例如格式化後的日期）。
 */
export function buildHaystack(row, fields) {
  let s = ''
  for (const f of fields) {
    const v = typeof f === 'function' ? f(row) : row?.[f]
    if (v == null || v === '') continue
    s += (Array.isArray(v) ? v.join(' ') : String(v)).toLowerCase()
    s += ' ' // 欄位分隔：避免「前一欄尾＋後一欄頭」被誤判為命中
  }
  return s
}

/**
 * 列比對：欄位限定 token 只比該欄位，其餘走全文（haystack 惰性建構，
 * 純欄位條件的查詢不必為每列組整串）。
 * @param {any} row
 * @param {ReturnType<typeof tokenize>} tokens
 * @param {(string|((row:any)=>any))[]} fields 全文搜尋欄位
 * @param {Record<string, (string|((row:any)=>any))[]>} [aliases] 欄位別名表（key 小寫）
 */
export function matchesQuery(row, tokens, fields, aliases) {
  let hay = null
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]
    // hasOwnProperty 把關：`constructor:x` / `tostring:x` 這種欄位名會撈到 Object.prototype
    // 上的成員（truthy 但不是陣列），直接進 buildHaystack 會丟 not iterable
    const spec =
      tk.field && aliases && Object.prototype.hasOwnProperty.call(aliases, tk.field)
        ? aliases[tk.field]
        : null
    if (Array.isArray(spec)) {
      // `欄位:*`＝該欄不為空（備註欄稀疏，讓使用者先撈出「有寫東西的列」）
      if (tk.value === '*' || tk.value === '＊') {
        if (!buildHaystack(row, spec).trim()) return false
        continue
      }
      if (!buildHaystack(row, spec).includes(tk.value)) return false
      continue
    }
    // 欄位名不認得 → 整個 token 當全文詞
    if (hay === null) hay = buildHaystack(row, fields)
    if (!hay.includes(tk.raw)) return false
  }
  return true
}

/**
 * 語法說明用的欄位名顯示：英文介面只列英文別名，中／日介面同時列出母語與英文。
 * （別名表本身三語全收，這裡只挑要展示的兩個）
 */
export function syntaxName(lang, zh, ja, en) {
  if (lang === 'en') return en
  return `${lang === 'ja' ? ja : zh} / ${en}`
}

/* ========================= 各表取值輔助 ========================= */

/**
 * 日期欄取值：Tabulator mutator 後 time 是 'YYYY/MM/DD HH:mm'（本地時區），
 * 回傳「原樣＋短橫線版」讓 `日期:2026-08` 與 `日期:2026/08` 都命中。
 * null（不留檔場）經 dayjs 會變 'Invalid Date'，視同空值。
 */
const dateText = (r) => {
  const v = r?.time
  if (v == null || v === '') return ''
  const s = String(v)
  if (s === 'Invalid Date') return ''
  const dashed = s.replace(/\//g, '-')
  return dashed === s ? s : `${s} ${dashed}`
}

/** 分類欄：streamlist 的 categories 是陣列（也可能是字串） */
const catText = (r) => {
  const v = r?.categories
  if (Array.isArray(v)) return v.join(' ')
  return v == null ? '' : String(v)
}

/* ========================= 各表欄位別名表 ========================= */
//
// key 一律小寫（tokenize 已把欄位名轉小寫）；中／英／日三語都收。
// value 為「該別名對應的取值欄位陣列」——雙語欄（曲名/歌手）同時比日文與英文欄，
// 與各表 headerFilterFunc 的既有行為一致。

const F_SONG = ['songName', 'songNameEn']
const F_ARTIST = ['artist', 'artistEn']
const F_DATE = [dateText]
const F_CAT = [catText]

/**
 * 四張表的搜尋規格。
 *   fields   全文搜尋掃的欄位（無欄位限定的 token 用）
 *   aliases  `欄位:值` 的別名表
 *   help     「?」說明面板列出的欄位（zh/ja/en＝可輸入的別名，label＝補充說明）
 *   examples 可點擊套用的範例（值取自實際資料，點下去不會 0 筆）
 */
export const SEARCH_SPECS = {
  songlist: {
    fields: ['songID', 'songName', 'songNameEn', 'artist', 'artistEn', 'genre', 'tieup', 'songNote'],
    aliases: {
      曲名: F_SONG,
      歌名: F_SONG,
      song: F_SONG,
      songname: F_SONG,
      title: F_SONG,
      歌手: F_ARTIST,
      artist: F_ARTIST,
      アーティスト: F_ARTIST,
      曲風: ['genre'],
      類型: ['genre'],
      genre: ['genre'],
      ジャンル: ['genre'],
      連動: ['tieup'],
      連動作品: ['tieup'],
      tieup: ['tieup'],
      タイアップ: ['tieup'],
      備註: ['songNote'],
      note: ['songNote'],
      メモ: ['songNote'],
      id: ['songID'],
      songid: ['songID'],
    },
    help: [
      { zh: '曲名', ja: '曲名', en: 'song', label: { zh: '日文・英文歌名', en: 'JA + EN song name', ja: '日本語・英語の曲名' } },
      { zh: '歌手', ja: 'アーティスト', en: 'artist', label: { zh: '日文・英文歌手', en: 'JA + EN artist', ja: '日本語・英語のアーティスト' } },
      { zh: '曲風', ja: 'ジャンル', en: 'genre', label: { zh: '', en: '', ja: '' } },
      { zh: '連動', ja: 'タイアップ', en: 'tieup', label: { zh: '連動作品', en: 'Tie-up', ja: 'タイアップ' } },
      { zh: '備註', ja: 'メモ', en: 'note', label: { zh: '', en: '', ja: '' } },
      { zh: 'id', ja: 'id', en: 'id', label: { zh: '曲目 ID', en: 'Song ID', ja: '曲 ID' } },
    ],
    examples: {
      zh: ['曲風:アニソン 歌手:ワルキューレ', '歌手:"苺咲べりぃ"', '備註:*'],
      en: ['genre:アニソン artist:ワルキューレ', 'artist:"苺咲べりぃ"', 'note:*'],
      ja: ['ジャンル:アニソン アーティスト:ワルキューレ', 'アーティスト:"苺咲べりぃ"', 'メモ:*'],
    },
  },

  setlist: {
    fields: ['songName', 'songNameEn', 'artist', 'artistEn', 'note', 'streamID', dateText],
    aliases: {
      曲名: F_SONG,
      歌名: F_SONG,
      song: F_SONG,
      songname: F_SONG,
      歌手: F_ARTIST,
      artist: F_ARTIST,
      アーティスト: F_ARTIST,
      備註: ['note'],
      note: ['note'],
      メモ: ['note'],
      日期: F_DATE,
      date: F_DATE,
      日付: F_DATE,
      時間: F_DATE,
      time: F_DATE,
      月: F_DATE,
      月份: F_DATE,
      month: F_DATE,
      場次: ['streamID'],
      stream: ['streamID'],
      streamid: ['streamID'],
      配信: ['streamID'],
      id: ['streamID'],
    },
    help: [
      { zh: '曲名', ja: '曲名', en: 'song', label: { zh: '日文・英文歌名', en: 'JA + EN song name', ja: '日本語・英語の曲名' } },
      { zh: '歌手', ja: 'アーティスト', en: 'artist', label: { zh: '日文・英文歌手', en: 'JA + EN artist', ja: '日本語・英語のアーティスト' } },
      { zh: '備註', ja: 'メモ', en: 'note', label: { zh: '', en: '', ja: '' } },
      { zh: '日期', ja: '日付', en: 'date', label: { zh: 'YYYY-MM／YYYY-MM-DD', en: 'YYYY-MM / YYYY-MM-DD', ja: 'YYYY-MM／YYYY-MM-DD' } },
      { zh: '場次', ja: '配信', en: 'stream', label: { zh: '影片 ID', en: 'Video ID', ja: '動画 ID' } },
    ],
    examples: {
      zh: ['歌手:YOASOBI 日期:2026-07', '曲名:"夜に駆ける"', '備註:初回'],
      en: ['artist:YOASOBI date:2026-07', 'song:"夜に駆ける"', 'note:初回'],
      ja: ['アーティスト:YOASOBI 日付:2026-07', '曲名:"夜に駆ける"', 'メモ:初回'],
    },
  },

  streamlist: {
    fields: ['streamID', 'title', 'note', catText, dateText],
    aliases: {
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
      日期: F_DATE,
      date: F_DATE,
      日付: F_DATE,
      時間: F_DATE,
      time: F_DATE,
      月: F_DATE,
      月份: F_DATE,
      month: F_DATE,
      id: ['streamID'],
      streamid: ['streamID'],
    },
    help: [
      { zh: '標題', ja: 'タイトル', en: 'title', label: { zh: '', en: '', ja: '' } },
      { zh: '分類', ja: 'カテゴリ', en: 'category', label: { zh: '', en: '', ja: '' } },
      { zh: '備註', ja: 'メモ', en: 'note', label: { zh: '', en: '', ja: '' } },
      { zh: '日期', ja: '日付', en: 'date', label: { zh: 'YYYY-MM／YYYY-MM-DD', en: 'YYYY-MM / YYYY-MM-DD', ja: 'YYYY-MM／YYYY-MM-DD' } },
      { zh: 'id', ja: 'id', en: 'id', label: { zh: '影片 ID', en: 'Video ID', ja: '動画 ID' } },
    ],
    // 第一則刻意混「欄位限定＋純全文詞」示範兩者可並用；年份用全文比對，
    // 不寫死到某個月（寫死的月份一旦資料還沒到就會點下去 0 筆）
    examples: {
      zh: ['分類:歌枠 2026', '標題:"karaoke"', '備註:*'],
      en: ['category:歌枠 2026', 'title:"karaoke"', 'note:*'],
      ja: ['カテゴリ:歌枠 2026', 'タイトル:"karaoke"', 'メモ:*'],
    },
  },

  aliases: {
    fields: ['canonicalName', 'aliasValue', 'note', 'aliasType', 'songID'],
    aliases: {
      類型: ['aliasType'],
      type: ['aliasType'],
      タイプ: ['aliasType'],
      種別: ['aliasType'],
      名稱: ['canonicalName'],
      名称: ['canonicalName'],
      標準名稱: ['canonicalName'],
      正式名稱: ['canonicalName'],
      正式名: ['canonicalName'],
      name: ['canonicalName'],
      canonical: ['canonicalName'],
      標準名: ['canonicalName'],
      別名: ['aliasValue'],
      alias: ['aliasValue'],
      value: ['aliasValue'],
      エイリアス: ['aliasValue'],
      備註: ['note'],
      note: ['note'],
      メモ: ['note'],
      id: ['songID'],
      songid: ['songID'],
    },
    help: [
      { zh: '類型', ja: 'タイプ', en: 'type', label: { zh: 'title / artist', en: 'title / artist', ja: 'title / artist' } },
      { zh: '名稱', ja: '名称', en: 'name', label: { zh: '標準名稱', en: 'Canonical name', ja: '標準名' } },
      { zh: '別名', ja: 'エイリアス', en: 'alias', label: { zh: '', en: '', ja: '' } },
      { zh: '備註', ja: 'メモ', en: 'note', label: { zh: '', en: '', ja: '' } },
      { zh: 'id', ja: 'id', en: 'id', label: { zh: '綁定的曲目 ID', en: 'Bound song ID', ja: '紐付け曲 ID' } },
    ],
    // 第三則用 id:* 而非 note:*——別名表的備註目前全空，點下去 0 筆會讓人以為語法壞了；
    // 綁定 songID 的 title 別名則有一批，剛好示範「該欄不為空」的用途
    examples: {
      zh: ['類型:artist 名稱:B小町', '別名:"Folder 5"', 'id:*'],
      en: ['type:artist name:B小町', 'alias:"Folder 5"', 'id:*'],
      ja: ['タイプ:artist 名称:B小町', 'エイリアス:"Folder 5"', 'id:*'],
    },
  },
}

/** 取某頁的搜尋規格；非表格頁回 null */
export function getSearchSpec(process) {
  return (process && SEARCH_SPECS[process]) || null
}

/** 「?」說明面板的固定文案（三語） */
export const SEARCH_HELP_TEXT = {
  zh: {
    title: '搜尋語法',
    intro:
      '直接輸入文字＝搜尋全部欄位；<code>欄位:值</code> 可限定單一欄位，空白分隔多個條件（全部成立）。值含空白時用引號括住，<code>欄位:*</code> 表示該欄不為空。認不得的欄位名會整串當一般文字比對（所以 <code>12:34</code> 不會被誤拆）。',
    fields: '可用欄位',
    examples: '範例（點擊套用）',
  },
  en: {
    title: 'Search syntax',
    intro:
      'Plain text searches every column. Use <code>field:value</code> to limit one column; separate conditions with spaces (all must match). Quote values containing spaces; <code>field:*</code> means the column is not empty. An unknown field name falls back to plain text (so <code>12:34</code> is never split).',
    fields: 'Fields',
    examples: 'Examples (click to apply)',
  },
  ja: {
    title: '検索の書き方',
    intro:
      'そのまま入力すると全項目を検索。<code>項目:値</code> で項目を限定でき、スペース区切りは AND 条件です。スペースを含む値は引用符で囲み、<code>項目:*</code> はその項目が空でない行。知らない項目名はそのまま文字列として扱われます（<code>12:34</code> は分割されません）。',
    fields: '使える項目',
    examples: '例（クリックで適用）',
  },
}
