/**
 * YouTube comments fetcher
 * Extracted from index.js to avoid circular dependency with data-processor.js
 */

import { CONFIG } from '../config.js'

export async function getVideoComments(videoId, apiKey) {
  if (!apiKey) {
    throw new Error('YouTube API 金鑰未設定')
  }

  try {
    const url = `${CONFIG.endpoints.youtubeAPI}?` +
      `key=${apiKey}&textFormat=${CONFIG.youtube.textFormat}&part=${CONFIG.youtube.part}&videoId=${videoId}&maxResults=${CONFIG.youtube.maxResults}`

    const response = await fetch(url)
    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error?.message || 'YouTube API 錯誤')
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
