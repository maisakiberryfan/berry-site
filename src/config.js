/**
 * @fileoverview Configuration settings for AI Setlist Parser Worker
 */

export const CONFIG = {
  // Berry channel IDs (single source of truth)
  berryChannels: [
    'UC7A7bGRVdIwo93nqnA3x-OQ', // 主頻道
    'UCBOGwPeBtaPRU59j8jshdjQ',
    'UC2cgr_UtYukapRUt404In-A',
  ],
  membershipPlaylistId: 'PLnWT3dUyDsU6hCaYuVsiwsSF8luEilys8',

  // API endpoints
  endpoints: {
    youtubeAPI: 'https://www.googleapis.com/youtube/v3/commentThreads'
  },

  // YouTube CommentThreads API settings
  youtube: {
    maxResults: 100,
    textFormat: 'plainText',
    part: 'snippet',
  },

  // Setlist detection keywords
  setlistKeywords: [
    // Japanese
    'セットリスト', 'セトリ', '歌単', '歌リスト',
    '今日の歌', '本日の歌', '歌った曲',
    
    // English
    'setlist', 'set list', 'playlist', 'song list',
    'today\'s songs', 'songs sung',
    
    // Numeric indicators
    '1.', '2.', '3.', '4.', '5.',
    '１．', '２．', '３．', '４．', '５．',
    
    // Music symbols
    '♪', '🎵', '🎶', '🎤', '🎼'
  ],

  // Comment filtering settings
  commentFilter: {
    minLength: 100,        // Minimum character count
    minLines: 3,           // Minimum line count
    likeWeight: 2,         // Weight for like count in scoring
    lengthWeight: 0.1,     // Weight for text length in scoring
    // 挑留言防護（2026-06 Gh6AsG8DmCI 事故後加入，邏輯與 yt-setlist-discord 對齊）
    preferredAuthor: '@KL-gr1my',
    cooldownHours: 6,        // 直播結束後 N 小時內只認 preferredAuthor
    tsLineRatio: 0.5,        // 層2：帶時間戳行數佔比門檻（排除逐曲感想留言）
    keywordMinTimestamps: 2, // 層3：關鍵字匹配仍需的最低時間戳數
  },

  // 歌單解析熔斷：fuzzy match 結果過半是「*」（無法匹配）視為選錯留言，放棄整場
  // minLines 5→3（2026-07-10）：6/15 IZhkPVy62qY 名言留言僅 4 行（4/4 無匹配）繞過熔斷、
  // 建了 4 筆垃圾新曲；3-4 行且過半真初回的場極罕見，必要時 force=true 可手動 bypass
  setlistCircuitBreak: {
    minLines: 3,
    starRatio: 0.5
  },

  // Free chat（常駐待機所）過濾：upcoming 且排程超過此天數＝free chat（如 Freee chat 排 2027），
  // 不入庫也不出現在最新影片。正常預約枠最多排數天，30 天不會誤傷。
  // 寫入端（auto-update）與查詢端（/api/yt/latest）共用此值，避免兩層閾值不一致產生縫隙
  freechatFilter: {
    horizonDays: 30
  },

  // Response limits
  limits: {
    maxCandidates: 3,      // Max candidates to return in debug
    maxSampleComments: 5   // Max sample comments to return
  },

  // CORS settings
  cors: {
    allowedOrigins: (origin) => {
      const allowed = [
        'https://m-b.win',
        'https://www.m-b.win',
        'http://localhost:8787',
        'http://localhost:8788',
        'http://127.0.0.1:3001',
        'http://127.0.0.1:8787',
        'http://127.0.0.1:8788',
      ]
      if (allowed.includes(origin)) return origin
      // 註：這裡曾有 `origin.endsWith('.maisakiberry.pages.dev')` 的 CF Pages preview
      // 放行分支——該部署形式已不存在（2026-03 起靜態檔案走 S3+CloudFront 與 Workers
      // Static Assets），留著只是一條「任何人註冊得到的子網域名就能取得跨站憑證」的死路。
      return false
    },
    // PATCH：/api/streamlist/bulk-categories 用的方法；漏列時瀏覽器 preflight 不放行
    // ⇒ 跨源呼叫（v3 dev server 之外的情境）會被 CORS 擋掉
    allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-Trigger-Token：/trigger-* 與 /api/parse-setlist 的憑證 header，同理需列入
    // allowHeaders，否則從瀏覽器發的跨源請求連 preflight 都過不了
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Source', 'X-Trigger-Token', 'If-None-Match'],
    exposeHeaders: ['ETag']
  },

  // Comparison mode settings
  comparisonModes: {
    recent: { days: 7 },
    all: {}
  }

}

