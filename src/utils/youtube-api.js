/**
 * YouTube API utility functions
 * Merged from YTID service - provides direct YouTube Data API v3 access
 */

import { getSecret } from '../platform.js'

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

// Default target channels (configurable via env)
const DEFAULT_TARGET_CHANNELS = [
  'UC7A7bGRVdIwo93nqnA3x-OQ',
  'UCBOGwPeBtaPRU59j8jshdjQ',
  'UC2cgr_UtYukapRUt404In-A',
  'PLnWT3dUyDsU6hCaYuVsiwsSF8luEilys8'  // Membership playlist
]

const DEFAULT_MEMBERSHIP_PLAYLIST_ID = 'PLnWT3dUyDsU6hCaYuVsiwsSF8luEilys8'

// Get configured channels from env or use defaults
function getTargetChannels(env) {
  const channelsStr = getSecret(env, 'TARGET_CHANNELS')
  if (channelsStr) {
    try { return JSON.parse(channelsStr) } catch { /* use defaults */ }
  }
  return DEFAULT_TARGET_CHANNELS
}

function getMembershipPlaylistId(env) {
  return getSecret(env, 'MEMBERSHIP_PLAYLIST_ID') || DEFAULT_MEMBERSHIP_PLAYLIST_ID
}

// Convert Channel ID to Playlist ID (UC -> UU)
function channelIdToPlaylistId(channelId) {
  if (channelId.startsWith('UC')) {
    return 'UU' + channelId.substring(2)
  }
  return channelId
}

// Pre-categorize videos based on title keywords
export function preCategory(title) {
  if (!title) return 'other'

  const t = title.toLowerCase()
  const origin = ['xfd', 'オリジナル', 'music video']
  const chat = ['chat', 'talk', '雑談']

  if (title.includes('歌枠')) {
    return '歌枠 / Singing'
  } else if (t.includes('gam')) {
    return 'ゲーム / Gaming'
  } else if (t.includes('short')) {
    return 'ショート / Shorts'
  } else if (t.includes('歌ってみた')) {
    return '歌ってみた動画 / Cover movie'
  } else if (origin.some(e => t.includes(e))) {
    return 'オリジナル曲 / Original Songs'
  } else if (chat.some(e => t.includes(e))) {
    return '雑談 / Chatting'
  } else {
    return 'other'
  }
}

// Make authenticated YouTube API request
export async function makeYouTubeAPIRequest(url, env) {
  const apiKey = getSecret(env, 'YOUTUBEAPIKEY') || getSecret(env, 'YOUTUBE_API_KEY')

  if (!apiKey) {
    throw new Error('YouTube API Key 未配置')
  }

  const urlWithKey = url + (url.includes('?') ? '&' : '?') + `key=${apiKey}`

  try {
    const response = await fetch(urlWithKey, {
      headers: {
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`YouTube API HTTP ${response.status}:`, errorText)
      throw new Error(`YouTube API 請求失敗：HTTP ${response.status}`)
    }

    return await response.json()
  } catch (error) {
    console.error('YouTube API request error:', error)
    throw error
  }
}

// Get baseline timestamp from database (replaces Hyperdrive HTTP call)
export async function getBaselineTimestamp(db) {
  try {
    const result = await db.first(
      "SELECT time FROM streamlist ORDER BY time DESC LIMIT 1"
    )

    if (!result?.time) {
      throw new Error('找不到最新的 streamlist 時間資料')
    }

    return new Date(result.time)
  } catch (error) {
    console.error('Failed to get baseline timestamp:', error)
    throw error
  }
}

// Get recent video IDs from a channel or playlist with time filtering
export async function getChannelRecentVideoIds(channelId, env, baselineTime, maxResults = 50) {
  const membershipPlaylistId = getMembershipPlaylistId(env)

  try {
    let playlistId
    if (channelId.startsWith('PL')) {
      playlistId = channelId
    } else {
      playlistId = channelIdToPlaylistId(channelId)
    }

    const url = `${YOUTUBE_API_BASE}/playlistItems?maxResults=${maxResults}&part=snippet&fields=pageInfo,nextPageToken,items(snippet(title,resourceId(videoId),description,publishedAt))&playlistId=${playlistId}`
    const response = await makeYouTubeAPIRequest(url, env)

    let items = response.items || []

    // Filter membership videos if this is the membership playlist
    if (channelId === membershipPlaylistId) {
      items = items.filter(video => {
        const description = video.snippet?.description || ''
        return description.includes('🍓 membership')
      })
    }

    // Time filtering using publishedAt
    if (baselineTime) {
      items = items.filter(video => {
        const publishedAt = video.snippet?.publishedAt
        if (publishedAt) {
          return new Date(publishedAt) > baselineTime
        }
        return false
      })
    }

    return { items, authMethod: 'API Key' }
  } catch (error) {
    console.error(`Failed to get video IDs for ${channelId}:`, error)
    return { items: [], authMethod: 'Failed - API Key 認證失敗' }
  }
}

// Get video details from multiple video IDs
export async function getVideoDetails(videoIds, env) {
  if (!videoIds || videoIds.length === 0) {
    return { items: [], authMethod: 'No videos to fetch' }
  }

  try {
    const videoIdString = videoIds.slice(0, 50).join(',')
    const url = `${YOUTUBE_API_BASE}/videos?part=id,snippet,liveStreamingDetails&fields=items(id,snippet(publishedAt,channelId,title,liveBroadcastContent),liveStreamingDetails(scheduledStartTime))&id=${videoIdString}`
    const response = await makeYouTubeAPIRequest(url, env)

    return { items: response.items || [], authMethod: 'API Key' }
  } catch (error) {
    console.error('Failed to get video details:', error)
    return { items: [], authMethod: 'Failed - API Key 認證失敗' }
  }
}

// Get new videos from multiple channels (main aggregation function)
export async function getNewVideosFromChannels(env, db) {
  const targetChannels = getTargetChannels(env)

  try {
    const baselineTime = await getBaselineTimestamp(db)
    console.log(`Using baseline time: ${baselineTime.toISOString()}`)

    // Get video IDs from all channels in parallel
    const sourcePromises = targetChannels.map(channelId =>
      getChannelRecentVideoIds(channelId, env, baselineTime)
    )
    const sourceResults = await Promise.all(sourcePromises)

    // Collect unique video IDs
    const allVideoIds = []
    const videoIdSet = new Set()
    const authMethods = new Set()

    sourceResults.forEach(({ items: videos, authMethod }) => {
      authMethods.add(authMethod)
      videos.forEach(video => {
        const videoId = video.snippet?.resourceId?.videoId
        if (videoId && !videoIdSet.has(videoId)) {
          videoIdSet.add(videoId)
          allVideoIds.push(videoId)
        }
      })
    })

    if (allVideoIds.length === 0) {
      return { items: [], authMethods: Array.from(authMethods) }
    }

    // Get detailed video information
    const videoDetailsResult = await getVideoDetails(allVideoIds, env)
    authMethods.add(videoDetailsResult.authMethod)

    // Filter by actual publish/start date
    const filteredVideos = []
    videoDetailsResult.items.forEach(video => {
      const actualStartTime = video.liveStreamingDetails?.scheduledStartTime || video.snippet?.publishedAt
      if (actualStartTime && new Date(actualStartTime) > baselineTime) {
        filteredVideos.push(video)
      }
    })

    // Sort newest first
    filteredVideos.sort((a, b) => {
      const timeA = new Date(a.liveStreamingDetails?.scheduledStartTime || a.snippet?.publishedAt)
      const timeB = new Date(b.liveStreamingDetails?.scheduledStartTime || b.snippet?.publishedAt)
      return timeB - timeA
    })

    return { items: filteredVideos, authMethods: Array.from(authMethods), baselineTime }
  } catch (error) {
    console.error('Error getting new videos:', error)
    throw error
  }
}

// Get single video info
export async function getVideoInfo(videoId, env) {
  const url = `${YOUTUBE_API_BASE}/videos?part=id,snippet,liveStreamingDetails&fields=items(id,snippet(publishedAt,channelId,title,liveBroadcastContent),liveStreamingDetails(scheduledStartTime))&id=${videoId}`
  const result = await makeYouTubeAPIRequest(url, env)

  if (result.items && result.items.length > 0) {
    result.items = result.items.map(video => ({
      ...video,
      time: video.liveStreamingDetails?.scheduledStartTime || video.snippet?.publishedAt
    }))
  }

  return result
}

// Get live streaming details (for polling actualEndTime)
export async function getLiveDetails(videoId, env) {
  const url = `${YOUTUBE_API_BASE}/videos?part=liveStreamingDetails,snippet&fields=items(id,snippet(title),liveStreamingDetails(scheduledStartTime,actualStartTime,actualEndTime))&id=${videoId}`
  const result = await makeYouTubeAPIRequest(url, env)

  if (!result.items || result.items.length === 0) {
    return null
  }

  const video = result.items[0]
  const liveDetails = video.liveStreamingDetails || {}

  return {
    videoId: video.id,
    title: video.snippet?.title,
    scheduledStartTime: liveDetails.scheduledStartTime || null,
    actualStartTime: liveDetails.actualStartTime || null,
    actualEndTime: liveDetails.actualEndTime || null,
    isLive: !!(liveDetails.actualStartTime && !liveDetails.actualEndTime),
    isEnded: !!liveDetails.actualEndTime
  }
}

// Get latest video from specific playlist
export async function getLatestVideo(env) {
  const playlistId = 'UU7A7bGRVdIwo93nqnA3x-OQ'
  const url = `${YOUTUBE_API_BASE}/playlistItems?playlistId=${playlistId}&part=snippet,contentDetails&fields=items(snippet(publishedAt,title,thumbnails(medium),resourceId(videoId)))&maxResults=1`
  return await makeYouTubeAPIRequest(url, env)
}
