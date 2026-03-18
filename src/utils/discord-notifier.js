/**
 * Discord 通知模組
 * 統一處理所有 Discord webhook 通知
 */

import { getSecret } from '../platform.js'

/**
 * 發送 Discord 通知
 * @param {Object} env - 環境變數（包含 DISCORD_WEBHOOK_URL）
 * @param {Object} payload - 通知內容
 * @param {string} payload.type - 通知類型：'auto-update' | 'manual-parse' | 'polling-parse'
 * @param {Object} payload.result - 結果資料
 * @param {boolean} payload.success - 是否成功
 * @param {string} [payload.error] - 錯誤訊息（失敗時）
 */
export async function sendDiscordNotification(env, payload) {
  const webhookUrl = getSecret(env, 'DISCORD_WEBHOOK_URL')
  if (!webhookUrl) {
    console.log('Discord webhook URL not configured, skipping notification')
    return
  }

  try {
    const embed = buildEmbed(payload)

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [embed]
      })
    })

    console.log('Discord notification sent successfully')
  } catch (error) {
    console.error('Failed to send Discord notification:', error)
    // 不拋出錯誤，避免影響主流程
  }
}

/**
 * 建立 Discord embed 物件
 */
function buildEmbed(payload) {
  const { type } = payload

  if (type === 'auto-update') {
    return buildAutoUpdateEmbed(payload)
  } else if (type === 'manual-parse') {
    return buildManualParseEmbed(payload)
  } else if (type === 'polling-parse') {
    return buildPollingParseEmbed(payload)
  } else {
    throw new Error(`Unknown notification type: ${type}`)
  }
}

/**
 * 建立自動更新通知 embed
 */
function buildAutoUpdateEmbed(payload) {
  const { result, success = true } = payload

  const embed = {
    title: success ? '✅ 自動更新完成' : '❌ 自動更新失敗',
    color: success ? 0x00ff00 : 0xff0000,
    timestamp: new Date().toISOString(),
    fields: []
  }

  // 📝 Streamlist 新增項目
  if (result.streamlistItems && result.streamlistItems.length > 0) {
    const streamlistText = result.streamlistItems
      .map(item => {
        const categories = item.category ? ` [${item.category.join(', ')}]` : ''
        return `• \`${item.date}-${item.videoId}\`${categories}\n  ${item.title || '（無標題）'}`
      })
      .join('\n')

    embed.fields.push({
      name: '📝 Streamlist 新增:',
      value: streamlistText.substring(0, 1024), // Discord 限制 1024 字元
      inline: false
    })
  }

  // 🎵 Setlist 解析項目
  if (result.setlistItems && result.setlistItems.length > 0) {
    const setlistText = result.setlistItems
      .map(item => {
        const debutCount = item.debutCount || 0
        const debutInfo = debutCount > 0 ? ` (含${debutCount}首初回)` : ''
        return `• \`${item.date}-${item.videoId}\` - ${item.songCount}首歌${debutInfo}`
      })
      .join('\n')

    embed.fields.push({
      name: '🎵 Setlist 解析完成:',
      value: setlistText.substring(0, 1024),
      inline: false
    })
  }

  // 🆕 初回歌曲詳情（新增到 Songlist）
  if (result.debutSongs && result.debutSongs.length > 0) {
    const debutText = result.debutSongs
      .map(video => {
        const songList = video.songs
          .map(song => `  - #${song.trackNo} **${song.songName}** (${song.artist})`)
          .join('\n')
        return `• \`${video.date}-${video.videoId}\`\n${songList}`
      })
      .join('\n')

    embed.fields.push({
      name: '🆕 新增初回歌曲到 Songlist:',
      value: debutText.substring(0, 1024),
      inline: false
    })
  }

  // ⚠️ 部分失敗項目
  if (result.failedItems && result.failedItems.length > 0) {
    const failedText = result.failedItems
      .map(item => `• \`${item.date}-${item.videoId}\`\n  錯誤: ${item.reason || item.error}`)
      .join('\n')

    embed.fields.push({
      name: '⚠️ 處理失敗:',
      value: failedText.substring(0, 1024),
      inline: false
    })
  }

  // ❌ 整體錯誤訊息
  if (!success && payload.error) {
    embed.fields.push({
      name: '❌ 錯誤訊息:',
      value: `\`\`\`${payload.error.substring(0, 900)}\`\`\``,
      inline: false
    })
  }

  // 📊 統計摘要
  const stats = buildStatsField(result)
  if (stats) {
    embed.fields.push(stats)
  }

  return embed
}

/**
 * 建立手動解析通知 embed
 */
function buildManualParseEmbed(payload) {
  const { success, streamID, title, songCount, error, debutSongs } = payload

  const embed = {
    title: success ? '✅ 手動解析完成' : '❌ 手動解析失敗',
    color: success ? 0x00ff00 : 0xff0000,
    timestamp: new Date().toISOString(),
    fields: []
  }

  // Stream 資訊
  embed.fields.push({
    name: '🎥 Stream ID:',
    value: `\`${streamID}\``,
    inline: true
  })

  if (title) {
    embed.fields.push({
      name: '📺 標題:',
      value: title,
      inline: false
    })
  }

  if (success) {
    // 成功時顯示歌曲數量
    embed.fields.push({
      name: '🎵 歌曲數量:',
      value: `${songCount} 首`,
      inline: true
    })

    // 初回歌曲資訊
    if (debutSongs && debutSongs.length > 0) {
      const debutText = debutSongs
        .map(song => `• #${song.trackNo} **${song.songName}** (${song.artist})`)
        .join('\n')

      embed.fields.push({
        name: '🆕 新增初回歌曲:',
        value: debutText.substring(0, 1024),
        inline: false
      })
    }
  } else {
    // 失敗時顯示錯誤訊息
    embed.fields.push({
      name: '❌ 錯誤訊息:',
      value: `\`\`\`${error ? error.substring(0, 900) : '未知錯誤'}\`\`\``,
      inline: false
    })
  }

  return embed
}

/**
 * 建立 Polling 解析通知 embed
 */
function buildPollingParseEmbed(payload) {
  const { success, streamID, title, songCount, error, debutSongs } = payload

  const embed = {
    title: success ? '🔄 Polling 解析完成' : '❌ Polling 解析失敗',
    color: success ? 0x3498db : 0xff0000,
    timestamp: new Date().toISOString(),
    fields: []
  }

  // Stream 資訊
  embed.fields.push({
    name: '🎥 Stream ID:',
    value: `\`${streamID}\``,
    inline: true
  })

  if (title) {
    embed.fields.push({
      name: '📺 標題:',
      value: title,
      inline: false
    })
  }

  if (success) {
    // 成功時顯示歌曲數量
    embed.fields.push({
      name: '🎵 歌曲數量:',
      value: `${songCount} 首`,
      inline: true
    })

    // 初回歌曲資訊
    if (debutSongs && debutSongs.length > 0) {
      const debutText = debutSongs
        .map(song => `• #${song.trackNo} **${song.songName}** (${song.artist})`)
        .join('\n')

      embed.fields.push({
        name: '🆕 新增初回歌曲:',
        value: debutText.substring(0, 1024),
        inline: false
      })
    }
  } else {
    // 失敗時顯示錯誤訊息
    embed.fields.push({
      name: '❌ 錯誤訊息:',
      value: `\`\`\`${error ? error.substring(0, 900) : '未知錯誤'}\`\`\``,
      inline: false
    })
  }

  return embed
}

/**
 * 建立統計摘要欄位
 */
function buildStatsField(result) {
  const stats = []

  const streamCount = result.streamlistItems?.length || 0
  const setlistCount = result.setlistItems?.length || 0
  const failedCount = result.failedItems?.length || 0
  const debutSongCount = result.debutSongs?.reduce((sum, video) => sum + video.songs.length, 0) || 0

  if (streamCount > 0) stats.push(`📝 新增 ${streamCount} 個 stream`)
  if (setlistCount > 0) stats.push(`🎵 解析 ${setlistCount} 個 setlist`)
  if (debutSongCount > 0) stats.push(`🆕 新增 ${debutSongCount} 首初回歌曲`)
  if (failedCount > 0) stats.push(`⚠️ ${failedCount} 個失敗`)

  if (stats.length === 0) {
    return null
  }

  return {
    name: '📊 統計摘要:',
    value: stats.join(' | '),
    inline: false
  }
}
