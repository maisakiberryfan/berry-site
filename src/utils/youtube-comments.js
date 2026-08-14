/**
 * YouTube comments fetcher
 * Extracted from index.js to avoid circular dependency with data-processor.js
 */

import { CONFIG } from '../config.js'

// 外部呼叫逾時（同 youtube-api.js）：無 timeout 的 fetch 會把整輪 cron 吊到被砍，
// 連 Discord 通知都發不出來。留言查詢正常 <1s
const COMMENTS_TIMEOUT_MS = 10_000

export async function getVideoComments(videoId, apiKey) {
  if (!apiKey) {
    throw new Error('YouTube API 金鑰未設定')
  }

  try {
    const url = `${CONFIG.endpoints.youtubeAPI}?` +
      `key=${apiKey}&textFormat=${CONFIG.youtube.textFormat}&part=${CONFIG.youtube.part}&videoId=${videoId}&maxResults=${CONFIG.youtube.maxResults}`

    // 逾時走既有的 catch → 包成「取得留言失敗：…」往上拋（與 API 錯誤同一條路徑）
    const response = await fetch(url, { signal: AbortSignal.timeout(COMMENTS_TIMEOUT_MS) })
    const data = await response.json()

    if (!response.ok) {
      throw new Error(data?.error?.message || 'YouTube API 錯誤')
    }

    return data.items?.map(item => ({
      text: item.snippet.topLevelComment.snippet.textDisplay,
      authorDisplayName: item.snippet.topLevelComment.snippet.authorDisplayName,
      likeCount: item.snippet.topLevelComment.snippet.likeCount
    })) || []
  } catch (error) {
    throw new Error(`取得留言失敗： ${error.message}`)
  }
}
