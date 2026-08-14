// 音樂作品（Discography）資料 —— 唯讀資料模組（比照 clothesData.js）
//
// 來源優先序：官方 discography 頁（maisakiberry.com/discography，1st~4th 曲目/曲序）
//            ＞ BOOTH 商品描述（曲目/staff 權威）＞ 官方特設頁（發行日/整體 staff）
//            ＞ iTunes（配信日/配信連結）＞ wiki（credits 補充與客座，已知數處錯誤不採信）
// links.stream＝配信聚合頁（官方/wiki 有標 linkco 者用之，其餘用 Apple Music）；
// links.xfd 與 track.youtube 存 YouTube videoId（來源：streamlist DB 的官方頻道影片）。
// instrumental:true＝實體含各曲 instrumental 版（官方 disco 頁/BOOTH 曲目確證），
// 頁面以一行註記呈現、不逐軌列出。
// songID 已人工對照 songlist（artist=苺咲べりぃ 優先）——⚠️ 勿自行改動：
//   ・かくれんぼ 專輯版與單曲版都是 167（168 是優里同名 cover，不是本人曲）
//   ・songID:null＝songlist 無此曲（未在歌枠唱過），頁面只用 name 顯示、不出現歌唱紀錄鈕
// 曲名一律留原文（不翻譯）；有 songID 時頁面改以 songlist 的 songName 顯示
//   （songlist 是曲名的單一事實來源，此處 name 僅作 fallback 與人工對照用）。
//
// 欄位（albums / singles 共用同一形狀，releases＝兩者相接）：
//   id            slug，同時是封面檔名 img/albums/{id}.webp、詳細頁路徑
//                 （/discography/rebirthr）與 OG 快照檔名（og/discography-rebirthr.html）。
//                 ⚠️ 本檔必須能被裸 Node 直接 import（scripts/og-config.mjs 讀它產 OG meta）：
//                 不得 import 任何吃 `import.meta.env` 的模組或 .svelte 檔
//   type          'album' | 'single' —— ⚠️ 保留欄位，目前頁面完全未讀取（專輯／單曲之分
//                 來自 albums / singles 兩個匯出，卡片標籤看的是有無 ordinal）。留著是為了
//                 日後若改成單一清單再分類；有新增資料時請照樣填。
//   ordinal       專輯序數（1st~10th）；單曲無
//   title         作品名（原文）
//   releaseDate   YYYY-MM-DD（專輯＝官方特設頁/M3 場次日；單曲＝iTunes 配信日）
//   links         有才顯示（1st 絕版、單曲無特設頁）：
//                   official  官方特設頁 URL
//                   booth     BOOTH 商品頁 URL
//                   stream    配信聚合頁 URL（linkco.re／Apple Music）
//                   xfd       XFD（クロスフェード試聽）的 YouTube videoId ——不是 URL
//   instrumental  true＝實體含各曲 instrumental 版；頁面以面板尾一行註記呈現、不逐軌列
//   bonusTracks   instrumental 以外的追加軌名陣列（目前僅 1st 的 BGM），與上面那行註記併排
//   staff         作品整體製作名單 [{ roles:[roleKey], name }]
//   tracks        [{ songID, name, youtube?, credits:[{ roles:[roleKey], name }] }]
//                   youtube  該曲 MV 的 YouTube videoId ——不是 URL
//
// credits 用「roles 陣列 ＋ 名字」而非 {lyrics, music, extra} 扁平欄位：
// 原始資料常見一人兼多職（「詞/Movie:苺咲べりぃ」「design/logo:来宮りお」「詞曲:立秋」），
// 用 roles 陣列才能忠實呈現「同一人擔任哪幾職」，也讓 ギター/MIX/SDイラスト 這類
// 零星職稱不必另立欄位。roleKey 的三語標籤在 Discography.svelte 的頁內字典。

/** 專輯（新→舊，同衣裝頁慣例；ordinal 保留原始序數） */
export const albums = [
  {
    id: 'rebirthr',
    type: 'album',
    ordinal: 10,
    title: 'RebiRthR!!!',
    releaseDate: '2026-04-26',
    links: {
      official: 'https://www.maisakiberry.com/10th-rebirthr',
      booth: 'https://booth.pm/ja/items/8206051',
      xfd: '5pE7T3uYxIM',
    },
    instrumental: true,
    staff: [
      { roles: ['illust'], name: 'みたう' },
      { roles: ['design', 'logo'], name: '来宮りお' },
      { roles: ['emblem'], name: 'ますだめぐみ' },
      { roles: ['mastering'], name: 'スタジオセブン' },
    ],
    tracks: [
      { songID: null, name: 'くるくる†トゥインクル', credits: [{ roles: ['lyrics', 'music'], name: '立秋' }] },
      {
        songID: 1023,
        name: 'KAWAII♥Shooting！',
        credits: [
          { roles: ['lyrics'], name: '葉月リョウヘイ(U-RASIA)' },
          { roles: ['music'], name: 'ひかげ' },
        ],
      },
      {
        songID: null,
        name: 'つながる☆ステラグラム',
        credits: [
          { roles: ['lyrics'], name: 'Kyrie' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      {
        songID: 1046,
        name: 'ハートアンドハート',
        credits: [
          { roles: ['lyrics'], name: '葉月リョウヘイ(U-RASIA)' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      // songlist 寫法為 'Happy, Likey'（逗號後有空白）；顯示以 songlist 為準
      { songID: 1021, name: 'Happy,Likey', youtube: 'htpuXviUngU', credits: [{ roles: ['lyrics', 'music'], name: 'ねぎとろ。' }] },
    ],
  },
  {
    id: 'lucisphere',
    type: 'album',
    ordinal: 9,
    title: 'Lucisphere',
    releaseDate: '2025-10-26',
    links: {
      official: 'https://www.maisakiberry.com/9th-lucisphere',
      booth: 'https://booth.pm/ja/items/7533758',
      xfd: 'Pb_hWvRwzp0',
    },
    instrumental: true,
    staff: [
      { roles: ['illust'], name: 'BORUMETE' },
      { roles: ['sdIllust'], name: '小吉よこ' },
      { roles: ['design', 'logo'], name: '来宮りお' },
      { roles: ['emblem'], name: 'ますだめぐみ' },
      { roles: ['mastering'], name: 'スタジオセブン' },
    ],
    tracks: [
      {
        songID: 935,
        name: 'innocence',
        credits: [
          { roles: ['lyrics'], name: '葉月リョウヘイ(U-RASIA)' },
          { roles: ['music'], name: 'ひかげ' },
        ],
      },
      {
        songID: 937,
        name: '虚飾のアスターテ',
        credits: [
          { roles: ['lyrics'], name: 'Kyrie' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      {
        songID: 938,
        name: 'レプリカ',
        credits: [
          { roles: ['lyrics'], name: '七乃二条（創作集団「カタリスト」）' },
          { roles: ['music'], name: 'Yuy（Secret Messenger）' },
          { roles: ['guitar'], name: 'りおんぬ（夜更かしインシデント）' },
          { roles: ['mix'], name: '羽鳥風画' },
        ],
      },
      { songID: 936, name: 'しらないうた', credits: [{ roles: ['lyrics', 'music'], name: 'ねぎとろ。' }] },
      // songlist 寫法為 'Drop Note'（中間有空白）
      {
        songID: 539,
        name: 'DropNote',
        youtube: 'NfF1BrPKdhQ',
        credits: [
          { roles: ['lyrics'], name: '結崎有理' },
          { roles: ['music'], name: 'lent/らん' },
        ],
      },
    ],
  },
  {
    id: 'reverser',
    type: 'album',
    ordinal: 8,
    title: 'ReveRseR!!!',
    releaseDate: '2025-04-27',
    links: {
      official: 'https://www.maisakiberry.com/8th-reverser',
      booth: 'https://booth.pm/ja/items/6808311',
      // iTunes 上配信名為「Rrr!!!」（曲目與 8th 完全一致，已核對）
      stream: 'https://music.apple.com/jp/album/rrr-ep/1837851346',
      xfd: '8zJaybGRNnQ',
    },
    instrumental: true,
    staff: [
      { roles: ['illust'], name: 'みたう' },
      { roles: ['design', 'logo'], name: '来宮りお' },
      { roles: ['emblem'], name: 'ますだめぐみ' },
      { roles: ['mastering'], name: 'スタジオセブン' },
    ],
    tracks: [
      { songID: 702, name: 'BlackBerry BlackOut', credits: [{ roles: ['lyrics', 'music'], name: '立秋' }] },
      {
        songID: 1004,
        name: 'フィニトネスの最終定理',
        credits: [
          { roles: ['lyrics'], name: 'Kyrie' },
          { roles: ['music'], name: 'HIR' },
        ],
      },
      {
        songID: null,
        name: '宵のミカボシ',
        credits: [
          { roles: ['lyrics'], name: 'Kyrie' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      {
        songID: 870,
        name: 'ラストディーヴァと光の歌',
        credits: [
          { roles: ['lyrics'], name: '葉月リョウヘイ(U-RASIA)' },
          { roles: ['music'], name: 'lent/らん' },
        ],
      },
      // ⚠️ 167＝本人原創曲；優里同名 cover 是 168，兩者不可混
      { songID: 167, name: 'かくれんぼ', youtube: 'NnlmnMSXIks', credits: [{ roles: ['lyrics', 'music'], name: 'ねぎとろ。' }] },
    ],
  },
  {
    id: 'animania',
    type: 'album',
    ordinal: 7,
    title: 'Animania',
    releaseDate: '2024-10-27',
    links: {
      official: 'https://www.maisakiberry.com/7th-animania',
      booth: 'https://booth.pm/ja/items/6174484',
      stream: 'https://music.apple.com/jp/album/animania-ep/1837849836',
      xfd: 'kZO0584z7t8',
    },
    instrumental: true,
    staff: [
      { roles: ['illust'], name: 'schatten' },
      { roles: ['sdIllust'], name: '小吉よこ' },
      { roles: ['design', 'logo'], name: '来宮りお' },
      { roles: ['emblem'], name: 'ますだめぐみ' },
      { roles: ['mastering'], name: 'スタジオセブン' },
    ],
    tracks: [
      {
        songID: 720,
        name: 'Berry nice！！',
        credits: [
          { roles: ['lyrics'], name: '葉月リョウヘイ(U-RASIA)' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      {
        songID: 733,
        name: '星になろうよ',
        credits: [
          { roles: ['lyrics'], name: '結崎有理' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      { songID: null, name: 'ワタシらしくてマインド', credits: [{ roles: ['lyrics', 'music'], name: 'ねぎとろ' }] },
      {
        songID: null,
        name: 'レジスタンツィア',
        credits: [
          { roles: ['lyrics'], name: 'Kyrie' },
          { roles: ['music'], name: '弘世' },
          { roles: ['mix'], name: '羽鳥風画' },
        ],
      },
      // songlist 寫法無句號（'キミのせいだよ'）
      {
        songID: 232,
        name: 'キミのせいだよ。',
        credits: [
          { roles: ['lyrics'], name: '葉月リョウヘイ(U-RASIA)' },
          { roles: ['music'], name: 'lent/らん' },
        ],
      },
    ],
  },
  {
    id: 'eee',
    type: 'album',
    ordinal: 6,
    title: 'EEE!!',
    releaseDate: '2024-04-28',
    links: {
      official: 'https://www.maisakiberry.com/6th-eee',
      booth: 'https://booth.pm/ja/items/5653892',
      stream: 'https://music.apple.com/jp/album/eee-ep/1837849494',
      xfd: 'pGUUNUp1VSI',
    },
    instrumental: true,
    staff: [
      { roles: ['illust'], name: 'みたう' },
      { roles: ['logo'], name: 'ますだめぐみ' },
      { roles: ['design'], name: '来宮りお' },
      { roles: ['mastering'], name: 'スタジオセブン' },
    ],
    tracks: [
      { songID: 309, name: 'GO 苺 WAY!', youtube: 'bRU8HQWTeOY', credits: [{ roles: ['lyrics', 'music'], name: '立秋' }] },
      {
        songID: 488,
        name: 'ツナガリ',
        credits: [
          { roles: ['lyrics'], name: 'Kyrie' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      {
        songID: null,
        name: 'Burning Bright',
        credits: [
          { roles: ['lyrics'], name: '七乃二条（創作集団「カタリスト」）' },
          { roles: ['music'], name: 'Yuy（Secret Messenger）' },
          { roles: ['mix'], name: '羽鳥風画' },
        ],
      },
      {
        songID: 541,
        name: 'ナカヨキコトハ',
        credits: [
          { roles: ['lyrics'], name: 'Kyrie' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      { songID: 360, name: 'Shoot！', credits: [{ roles: ['lyrics', 'music'], name: 'ねぎとろ。' }] },
    ],
  },
  {
    id: 'peace',
    type: 'album',
    ordinal: 5,
    title: 'Peace!',
    releaseDate: '2023-10-29',
    links: {
      official: 'https://www.maisakiberry.com/5th-peace',
      booth: 'https://booth.pm/ja/items/5164179',
      stream: 'https://music.apple.com/jp/album/peace-ep/1837850693',
      xfd: 'a0A91x4aD5I',
    },
    instrumental: true,
    staff: [
      { roles: ['illust'], name: '桃江もこ' },
      { roles: ['logo'], name: 'ますだめぐみ' },
      { roles: ['design'], name: '来宮りお' },
      { roles: ['mastering'], name: 'スタジオセブン' },
    ],
    tracks: [
      // BOOTH 寫 'CompleteMemorial'，songlist 正名 'Complete x Memorial'
      {
        songID: 270,
        name: 'Complete x Memorial',
        youtube: 'EZXrvoSWShk',
        credits: [
          { roles: ['lyrics'], name: '苺咲べりぃ' },
          { roles: ['music'], name: 'ねぎとろ。' },
        ],
      },
      {
        songID: 787,
        name: 'MiraiPrecious',
        credits: [
          { roles: ['lyrics'], name: '苺咲べりぃ' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      {
        songID: 510,
        name: 'to you.',
        youtube: 'BHEivoVyLTY',
        credits: [
          { roles: ['lyrics'], name: '苺咲べりぃ' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      {
        songID: 396,
        name: 'Starry',
        credits: [
          { roles: ['lyrics'], name: 'Kyrie' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      { songID: 258, name: 'GoodMorning,GoodNight', credits: [{ roles: ['lyrics', 'music'], name: 'ねぎとろ。' }] },
    ],
  },
  {
    id: 'bbb',
    type: 'album',
    ordinal: 4,
    title: 'BBB!',
    releaseDate: '2023-04-30',
    links: {
      official: 'https://www.maisakiberry.com/4th-bbb',
      booth: 'https://booth.pm/ja/items/4667754',
      stream: 'https://music.apple.com/jp/album/bbb-ep/1742982037',
      xfd: 'myJDBTC_wXg',
    },
    instrumental: true,
    staff: [
      { roles: ['illust'], name: 'みたう' },
      { roles: ['logo'], name: 'ますだめぐみ' },
      { roles: ['design'], name: '来宮りお' },
      { roles: ['mastering'], name: 'スタジオセブン' },
    ],
    tracks: [
      { songID: 772, name: '苺苺苺苺苺苺苺苺毎苺', youtube: 'BXoZVDwwOx0', credits: [{ roles: ['lyrics', 'music'], name: '立秋' }] },
      {
        songID: 274,
        name: 'コイハツライ',
        credits: [
          { roles: ['lyrics', 'music'], name: 'Yuy' },
          { roles: ['guitar'], name: '凱' },
        ],
      },
      {
        songID: 561,
        name: 'NewWorld!!',
        youtube: 'OKT-_NgzwUc',
        credits: [
          { roles: ['lyrics'], name: '苺咲べりぃ' },
          { roles: ['music'], name: '司/19G' },
        ],
      },
      {
        songID: 922,
        name: 'I Love. you love.',
        credits: [
          { roles: ['lyrics'], name: 'Kyrie' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      { songID: 394, name: 'Spring Rain', credits: [{ roles: ['lyrics', 'music'], name: 'ねぎとろ。' }] },
    ],
  },
  {
    id: 'serve',
    type: 'album',
    ordinal: 3,
    title: 'Serve!',
    releaseDate: '2022-10-30',
    links: {
      official: 'https://www.maisakiberry.com/3rd-serve',
      booth: 'https://booth.pm/ja/items/4234618',
      stream: 'https://music.apple.com/jp/album/serve-ep/1732546461',
      xfd: 'bZhGzxiAzQs',
    },
    instrumental: true,
    staff: [
      { roles: ['illust'], name: 'みわうに' },
      { roles: ['logo'], name: 'ますだめぐみ' },
      { roles: ['mastering'], name: 'スタジオセブン' },
    ],
    tracks: [
      {
        songID: 120,
        name: 'emotion',
        youtube: 'lcF5TP_S0J0',
        credits: [
          { roles: ['lyrics'], name: '苺咲べりぃ' },
          { roles: ['music'], name: 'ねぎとろ。' },
        ],
      },
      { songID: 712, name: 'プリズム・パ・ドゥ・ドゥ', credits: [{ roles: ['lyrics', 'music'], name: '司/19G' }] },
      { songID: 12, name: 'アイオライト', credits: [{ roles: ['lyrics', 'music'], name: 'Yuy' }] },
      {
        songID: 734,
        name: '星へ伸ばす手',
        youtube: 'wA-x1L4i2bM',
        credits: [
          { roles: ['lyrics'], name: 'kyrie' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
      // 官方 discography 頁第 5 曲：1st『Strawberry Garden』曲收錄（wiki 未列）
      {
        songID: 401,
        name: 'Start Roll',
        youtube: 'DERR5u1hOL8',
        credits: [
          { roles: ['lyrics'], name: '苺咲べりぃ' },
          { roles: ['music'], name: '羽鳥風画' },
        ],
      },
    ],
  },
  {
    id: 'bouquet',
    type: 'album',
    ordinal: 2,
    title: 'Bouquet.',
    releaseDate: '2022-04-24',
    links: {
      official: 'https://www.maisakiberry.com/2nd-bouquet',
      booth: 'https://booth.pm/ja/items/3790094',
      stream: 'https://music.apple.com/jp/album/bouquet-ep/1648028267',
      xfd: '8lYaEHpMD7o',
    },
    instrumental: true,
    staff: [
      { roles: ['illust'], name: 'みわうに' },
      { roles: ['logo'], name: 'ますだめぐみ' },
      { roles: ['mastering'], name: 'スタジオセブン' },
    ],
    tracks: [
      {
        songID: 346,
        name: '桜色√END',
        youtube: 'H0R7vsPWfyM',
        credits: [
          { roles: ['lyrics', 'movie'], name: '苺咲べりぃ' },
          { roles: ['music'], name: 'ねぎとろ。' },
          { roles: ['illust'], name: 'みわうに' },
        ],
      },
      { songID: 416, name: '彗星フラーウラ', credits: [{ roles: ['lyrics', 'music'], name: '司/19G' }] },
      { songID: 361, name: 'silhouette', credits: [{ roles: ['lyrics', 'music'], name: '司/19G' }] },
      {
        songID: 624,
        name: '春、青く澄みわたり',
        credits: [
          { roles: ['lyrics'], name: 'kyrie' },
          { roles: ['music'], name: 'ねぎとろ。' },
        ],
      },
      // 官方 discography 頁第 5 曲：1st『Strawberry Garden』曲收錄（wiki 未列）
      {
        songID: 596,
        name: 'Happy Lucky Strawberry',
        youtube: 'J6uKheDBHJI',
        credits: [
          { roles: ['lyrics'], name: '苺咲べりぃ' },
          { roles: ['music'], name: 'ねぎとろ。' },
        ],
      },
    ],
  },
  {
    id: 'strawberry-garden',
    type: 'album',
    ordinal: 1,
    title: 'Strawberry Garden',
    // iTunes 上的發行日；配信開始為 2022-04-02。實體已絕版（無特設頁／BOOTH）
    releaseDate: '2021-11-01',
    links: {
      // 官方 discography 頁標注的配信聚合連結
      stream: 'https://linkco.re/5RE1PHyF',
    },
    instrumental: true,
    // 官方 discography 頁的第 9 軌（instrumental 之外的 bonus）
    bonusTracks: ['BERRY ORIGINAL BGM 01'],
    staff: [],
    // 曲序照官方 discography 頁（01 New World!!；與 MV 發表順序不同）
    tracks: [
      {
        songID: 561,
        name: 'NewWorld!!',
        youtube: 'OKT-_NgzwUc',
        credits: [
          { roles: ['lyrics', 'movie'], name: '苺咲べりぃ' },
          { roles: ['music'], name: '司/19G' },
          { roles: ['illust'], name: 'みわうに' },
        ],
      },
      {
        songID: 401,
        name: 'Start Roll',
        youtube: 'DERR5u1hOL8',
        credits: [
          { roles: ['lyrics', 'movie'], name: '苺咲べりぃ' },
          { roles: ['music'], name: '羽鳥風画' },
          { roles: ['illust'], name: '桃江もこ' },
        ],
      },
      {
        songID: 510,
        name: 'to you.',
        youtube: 'BHEivoVyLTY',
        credits: [
          { roles: ['lyrics', 'movie'], name: '苺咲べりぃ' },
          { roles: ['music'], name: '羽鳥風画' },
          { roles: ['illust'], name: 'nibosi' },
        ],
      },
      {
        songID: 596,
        name: 'Happy Lucky Strawberry',
        youtube: 'J6uKheDBHJI',
        credits: [
          { roles: ['lyrics', 'movie'], name: '苺咲べりぃ' },
          { roles: ['music'], name: 'ねぎとろ。' },
          { roles: ['illust'], name: 'みわうに' },
        ],
      },
    ],
  },
]

/**
 * 單曲（新→舊）——2025 年「12 ヶ月連続チャレンジ」的配信單曲。
 * ⚠️ wiki 段標題寫「2026年」是錯的：iTunes 配信日、BOOTH 上架順序、setlist 最早演唱月
 *    三方交叉證實為 2025 年。2025-12 之後尚未發表的月份不建項。
 * staff：與同名專輯版相同者（かくれんぼ=8th／Drop Note=9th／Happy, Likey=10th）帶入，
 *        其餘來源未載明，留空不臆測。
 */
export const singles = [
  {
    id: 'itsumo-doori',
    type: 'single',
    title: 'いつも通りのI love you',
    releaseDate: '2025-12-22',
    links: {
      booth: 'https://booth.pm/ja/items/7776451',
      stream: 'https://music.apple.com/jp/album/my-usual-i-love-you-single/1863018965',
    },
    tracks: [{ songID: 966, name: 'いつも通りのI love you', youtube: '4kQH6ELDJ8Q', credits: [] }],
  },
  {
    id: 'kisetsu-no-hohaba',
    type: 'single',
    title: '季節の歩幅',
    releaseDate: '2025-12-15',
    links: {
      booth: 'https://booth.pm/ja/items/7707663',
      stream: 'https://linkco.re/Q1umeNZ3',
    },
    tracks: [{ songID: null, name: '季節の歩幅', youtube: 'zqyrT6ONh_c', credits: [] }],
  },
  {
    id: 'happy-likey',
    type: 'single',
    title: 'Happy, Likey',
    releaseDate: '2025-10-31',
    links: {
      booth: 'https://booth.pm/ja/items/7599259',
      stream: 'https://linkco.re/0dAgF8FB',
    },
    tracks: [{ songID: 1021, name: 'Happy, Likey', youtube: 'htpuXviUngU', credits: [{ roles: ['lyrics', 'music'], name: 'ねぎとろ。' }] }],
  },
  {
    id: 'towalove',
    type: 'single',
    title: 'TowaLove',
    releaseDate: '2025-10-01',
    links: {
      booth: 'https://booth.pm/ja/items/7469203',
      stream: 'https://linkco.re/mX7Vs0aA',
    },
    tracks: [{ songID: 932, name: 'TowaLove', youtube: 'edEixC0NJE0', credits: [] }],
  },
  {
    id: 'genjitsu',
    type: 'single',
    title: '幻日',
    releaseDate: '2025-07-31',
    links: {
      booth: 'https://booth.pm/ja/items/7245306',
      stream: 'https://linkco.re/NZ3q7CTF',
    },
    tracks: [{ songID: 268, name: '幻日', youtube: 'FBeKfnhStXc', credits: [] }],
  },
  {
    id: 'drop-note',
    type: 'single',
    title: 'Drop Note',
    releaseDate: '2025-06-30',
    links: {
      booth: 'https://booth.pm/ja/items/7108521',
      stream: 'https://linkco.re/rsgNFYF3',
    },
    tracks: [
      {
        songID: 539,
        name: 'Drop Note',
        youtube: 'NfF1BrPKdhQ',
        credits: [
          { roles: ['lyrics'], name: '結崎有理' },
          { roles: ['music'], name: 'lent/らん' },
        ],
      },
    ],
  },
  {
    id: 'happy-story',
    type: 'single',
    title: '全肯定ハピハピキュートSTORY！',
    releaseDate: '2025-05-28',
    links: {
      booth: 'https://booth.pm/ja/items/6973630',
      stream: 'https://linkco.re/ZFUr7mSg',
    },
    tracks: [{ songID: 433, name: '全肯定ハピハピキュートSTORY！', youtube: 'CfoE7AlT9Gw', credits: [] }],
  },
  {
    id: 'love-letter',
    type: 'single',
    title: 'love letter',
    releaseDate: '2025-04-30',
    links: {
      booth: 'https://booth.pm/ja/items/6856723',
      stream: 'https://linkco.re/YunrARMp',
    },
    tracks: [{ songID: 872, name: 'love letter', youtube: '-KV9NriS6Qw', credits: [] }],
  },
  {
    id: 'niji-no-mukougawa',
    type: 'single',
    title: '虹の向こう側',
    releaseDate: '2025-03-31',
    links: {
      booth: 'https://booth.pm/ja/items/6749581',
      stream: 'https://linkco.re/BdDfd9aT',
    },
    tracks: [{ songID: 574, name: '虹の向こう側', youtube: 'uJMo_6VWbNU', credits: [] }],
  },
  {
    id: 'tasting-my-love',
    type: 'single',
    title: 'Tasting my love！',
    releaseDate: '2025-02-15',
    links: {
      booth: 'https://booth.pm/ja/items/6590835',
      stream: 'https://linkco.re/5Q95Eh2Z',
    },
    tracks: [{ songID: 495, name: 'Tasting my love！', youtube: '0oiLP4U35wU', credits: [] }],
  },
  {
    id: 'kakurenbo',
    type: 'single',
    title: 'かくれんぼ',
    releaseDate: '2025-01-30',
    links: {
      booth: 'https://booth.pm/ja/items/6535210',
      stream: 'https://linkco.re/eCnrpsqE',
    },
    // ⚠️ 167＝本人原創曲（168 是優里同名 cover）
    tracks: [{ songID: 167, name: 'かくれんぼ', youtube: 'NnlmnMSXIks', credits: [{ roles: ['lyrics', 'music'], name: 'ねぎとろ。' }] }],
  },
]

/**
 * 客座演唱／参加楽曲（無封面卡，簡單列表＋外連）。
 * 新→舊排列。日期源：官方年表（maisakiberry.com/wark「歌唱担当」節）；
 * 年表未載的（Isolation／新星と光跡）採 M3 発表日（用戶提供＋影片發布日佐證）。
 * 欄位：
 *   id       hash／key 用 slug
 *   work     作品／廠牌／專輯名（原文）
 *   title    曲名（單曲時）；多曲時放 tracks
 *   roleKey  參與形式，三語標籤在頁面字典（ed／theme／feature；缺省＝僅演唱）
 *   noteKey  補充說明的字典 key（資訊不全時用）
 *   credits  同專輯 track 的結構
 *   date     YYYY-MM-DD（已知者）
 *   links    與 releases 同一種寫法（扁平 link／stream 已淘汰）：
 *              official  作品／廠牌官方頁 URL（頁面用作品名當連結文字）
 *              stream    配信頁／聚合頁 URL
 *   youtube  MV／XFD 的 YouTube videoId ——不是 URL
 *   startAt  搭配 youtube 的起始秒數（合輯 XFD 要跳到本曲時才有；頁面組成 ?t=）
 *   tracks   多曲參與時的軌列表 [{ no, name, songID, youtube? }]
 *   songID   songlist 對照（有值＝歌枠唱過，頁面照樣給歌唱紀錄）
 */
export const guests = [
  {
    id: 'isolation',
    work: 'iDearoom『メタ・アイソレーション;Null』',
    title: 'Isolation',
    roleKey: 'theme',
    // M3-2026春 発表（作品 PV 影片 2026-04-19 公開）
    date: '2026-04-26',
    credits: [{ roles: ['vocal'], name: '苺咲べりぃ' }],
    youtube: '8FOX4tC2rdA',
    songID: null,
  },
  {
    id: 'shinsei-to-koseki',
    work: '羽鳥風画『Vtuber Compilation』',
    title: '新星と光跡',
    // 作曲者合輯的 M3-2025春 発表；XFD 中本曲自 3:33 起
    date: '2025-04-27',
    credits: [
      { roles: ['vocal'], name: '苺咲べりぃ' },
      { roles: ['music'], name: '羽鳥風画' },
    ],
    youtube: 'LivAoGsPQes',
    startAt: 213,
    songID: null,
  },
  {
    id: 'candle-torch',
    work: 'LSCM Records',
    title: 'キャンドルトーチ',
    date: '2025-02-05',
    credits: [{ roles: ['vocal'], name: '苺咲べりぃ' }],
    links: { stream: 'https://ultravybe.lnk.to/candletorch' },
    songID: null,
  },
  {
    id: 'silk',
    work: 'LSCM Records',
    title: 'Silk',
    date: '2024-05-23',
    credits: [{ roles: ['vocal'], name: '苺咲べりぃ' }],
    links: { stream: 'https://music.apple.com/jp/album/silk-feat-maisaki-berry-single/1744555185' },
    songID: null,
  },
  {
    id: 'rose-cue-9-diva',
    work: 'ROSE CUE 9『Diva』',
    title: null,
    roleKey: 'feature',
    // 專輯發売日；Left Behind 曲的歌唱発表為 2022-11-03（官方年表）
    date: '2023-09-09',
    // linkco.re 是專輯本身的入口（頁面以作品名當連結文字），故放 official 不放 stream
    links: { official: 'https://linkco.re/BSVU12dq' },
    // 專輯內僅這三軌 feat. 苺咲べりぃ（軌號沿用專輯曲序）
    tracks: [
      { no: 1, name: 'parade', songID: null },
      { no: 6, name: 'Seaside Story', songID: null },
      { no: 7, name: 'Left Behind', songID: null, youtube: 'ypex3XueGeM' },
    ],
    credits: [{ roles: ['vocal'], name: '苺咲べりぃ' }],
    songID: null,
  },
  {
    id: 'back-to-that-summer',
    work: 'LSCM Records',
    title: 'Back To That Summer',
    date: '2022-08-04',
    // 雙人合唱（MV 標題「苺咲べりぃ & 夢羽九」）＋けーえぬP（iTunes feat. 三名連記）
    credits: [
      { roles: ['vocal'], name: '苺咲べりぃ' },
      { roles: ['vocal'], name: '夢羽九' },
      { roles: ['music'], name: 'けーえぬP' },
    ],
    links: {
      stream:
        'https://music.apple.com/jp/album/back-to-that-summer-feat-%E8%8B%BA%E5%92%B2%E3%81%B9%E3%82%8A%E3%81%83-%E5%A4%A2%E7%BE%BD%E4%B9%9D-%E3%81%91%E3%83%BC%E3%81%88%E3%81%ACp-single/1636701680',
    },
    youtube: 'HqIGeq4Usgc',
    songID: null,
  },
  {
    id: 'vvvvk',
    work: 'VVVVK: Rogue Vampire Hunter',
    title: null,
    roleKey: 'ed',
    // 官方年表：2022-07-04 作中歌歌唱（一部ボイス担当為 7/6 另計）
    date: '2022-07-04',
    noteKey: 'titleUnknownVoice',
    credits: [],
    songID: null,
  },
  {
    id: 'matsurika',
    work: 'LSCM Records',
    title: '茉莉花が花開く',
    date: '2022-06-22',
    credits: [{ roles: ['vocal'], name: '苺咲べりぃ' }],
    links: { stream: 'https://music.apple.com/jp/album/matsurikaga-hana-hiraku-feat-maisaki-berry-single/1790855345' },
    youtube: 'ZzcN4VFYrvE',
    songID: 773,
  },
  {
    id: 'my-dearly-feelings',
    work: 'フユキス',
    title: 'My Dearly Feelings',
    roleKey: 'ed',
    // 官方年表：2021-06-25 戯画『フユキス』EDテーマ歌唱
    date: '2021-06-25',
    credits: [
      { roles: ['vocal'], name: '苺咲べりぃ' },
      { roles: ['lyrics', 'music', 'arrange'], name: '羽鳥風画' },
    ],
    links: { official: 'http://www.entergram.co.jp/fuyukiss/' },
    songID: null,
  },
]

/** 專輯＋單曲（封面牆兩節共用的取值來源；hash 直達要跨兩節找作品） */
export const releases = [...albums, ...singles]

/** YYYY-MM-DD → 顯示用（zh/en 同格式 YYYY/MM/DD，ja 用 YYYY年M月D日） */
export function formatReleaseDate(iso, lang = 'zh') {
  if (typeof iso !== 'string' || iso.length < 10) return iso ?? ''
  const [y, mo, d] = iso.split('-')
  if (lang === 'ja') return `${y}年${Number(mo)}月${Number(d)}日`
  return `${y}/${mo}/${d}`
}

/** 英文序數（1st / 2nd / 3rd / 4th…）——專輯序數標記用 */
export function ordinalSuffix(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  const rem100 = v % 100
  if (rem100 >= 11 && rem100 <= 13) return `${v}th`
  switch (v % 10) {
    case 1:
      return `${v}st`
    case 2:
      return `${v}nd`
    case 3:
      return `${v}rd`
    default:
      return `${v}th`
  }
}
