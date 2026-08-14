/**
 * Discord 通知模組
 * 統一處理所有 Discord webhook 通知
 */

import { getSecret } from '../platform.js'

// 通知逾時：Discord webhook 掛住不值得把整輪 cron 吊到 Lambda 被砍
//（送不出去只是少一則通知，內部 catch 已回 false 讓呼叫端知道未送達）
const DISCORD_TIMEOUT_MS = 5_000

/**
 * 發送 Discord 通知
 * @param {Object} env - 環境變數（包含 DISCORD_WEBHOOK_URL）
 * @param {Object} payload - 通知內容
 * @param {string} payload.type - 通知類型：'auto-update' | 'manual-parse' | 'polling-parse' | 'snapshot'
 * @param {Object} payload.result - 結果資料
 * @param {boolean} payload.success - 是否成功
 * @param {string} [payload.error] - 錯誤訊息（失敗時）
 */
export async function sendDiscordNotification(env, payload) {
  const webhookUrl = getSecret(env, 'DISCORD_WEBHOOK_URL')
  if (!webhookUrl) {
    console.log('Discord webhook URL not configured, skipping notification')
    return false
  }

  try {
    const embed = buildEmbed(payload)

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [embed]
      }),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS)
    })
    if (!res.ok) {
      console.error(`Discord notification rejected: HTTP ${res.status}`)
      return false
    }

    console.log('Discord notification sent successfully')
    return true
  } catch (error) {
    console.error('Failed to send Discord notification:', error)
    // 不拋出錯誤，避免影響主流程；回傳 false 讓呼叫端知道未送達（攔截去重依賴此值）
    return false
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
  } else if (type === 'snapshot') {
    return buildSnapshotEmbed(payload)
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
        const skipped = item.skippedLines?.length
          ? `\n  ⚠️ 跳過 ${item.skippedLines.length} 行無戳雜訊: ${item.skippedLines.join('、').substring(0, 200)}`
          : ''
        return `• \`${item.date}-${item.videoId}\` - ${item.songCount}首歌${debutInfo}${skipped}`
      })
      .join('\n')

    embed.fields.push({
      name: '🎵 Setlist 解析完成:',
      value: setlistText.substring(0, 1024),
      inline: false
    })
  }

  // 🛡️ 防線攔截（熔斷/無戳全滅）：未入庫，需人工確認是否誤擋（誤擋可 force=true 重解析）。
  // 附被擋行內容——沒有內容就無從判斷是否誤擋，還得去翻 CloudWatch
  if (result.blockedItems && result.blockedItems.length > 0) {
    const blockedText = result.blockedItems
      .map(item => {
        const lines = item.skippedLines?.length
          ? `\n  被擋的行: ${item.skippedLines.join('、').substring(0, 200)}`
          : ''
        return `• \`${item.date}-${item.videoId}\`\n  ${item.reason}（留言 by ${item.commentAuthor || '?'}）${lines}`
      })
      .join('\n')

    embed.fields.push({
      name: '🛡️ 防線攔截（未入庫，請確認是否誤擋）:',
      value: blockedText.substring(0, 1024),
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

  // ❌ 整體錯誤訊息（payload.error 或 result.errors 皆顯示，否則失敗通知只有標題沒內容）
  const errorText = payload.error ||
    (result?.errors?.length > 0 ? result.errors.join('\n') : null)
  if (!success && errorText) {
    embed.fields.push({
      name: '❌ 錯誤訊息:',
      value: `\`\`\`${errorText.substring(0, 900)}\`\`\``,
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
  const { success, streamID, title, songCount, error, debutSongs, skippedLines } = payload

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

    // 無戳防線跳過的行（已過濾的雜訊，供人工確認）
    if (skippedLines && skippedLines.length > 0) {
      embed.fields.push({
        name: '⚠️ 跳過無戳雜訊行:',
        value: skippedLines.join('、').substring(0, 1024),
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
  const { success, streamID, title, songCount, error, debutSongs, skippedLines } = payload

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

    // 無戳防線跳過的行（已過濾的雜訊，供人工確認）
    if (skippedLines && skippedLines.length > 0) {
      embed.fields.push({
        name: '⚠️ 跳過無戳雜訊行:',
        value: skippedLines.join('、').substring(0, 1024),
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
 * 建立 CDN 快照 cron 通知 embed（src/cron-jobs/snapshot.js）
 * 只在整體失敗（ok=false）時發：快照過期沒有任何使用者可見的錯誤，
 * 不通知就等於「首訪永遠拿到某個舊版本」卻沒人知道
 */
function buildSnapshotEmbed(payload) {
  const { success = false, summary = {}, error } = payload

  const embed = {
    title: success ? '✅ CDN 快照更新完成' : '❌ CDN 快照更新失敗',
    color: success ? 0x00ff00 : 0xff0000,
    timestamp: new Date().toISOString(),
    fields: []
  }

  // 全域性的「這批為什麼不完整」——per-target 的 manifest 狀態在下面各自標註
  const globalNotes = []
  if (summary.manifestOk === false) globalNotes.push('manifest 抓取失敗/形狀不對')
  if (summary.budgetExceeded) globalNotes.push('抓取時間預算用盡')
  if (summary.monthIncomplete) globalNotes.push('月度檔不完整')

  embed.fields.push({
    name: '📦 產出:',
    value: `${summary.files ?? 0} 檔 / ${summary.months ?? 0} 個月份` +
      (globalNotes.length ? `（${globalNotes.join('、')}）` : ''),
    inline: true
  })

  if (typeof summary.durationMs === 'number') {
    embed.fields.push({
      name: '⏱️ 耗時:',
      value: `${(summary.durationMs / 1000).toFixed(1)}s`,
      inline: true
    })
  }

  // 每個站台都要看得出 **manifest 這輪有沒有 commit**——那才是「前端會不會讀到這批快照」
  // 的關鍵；寫入／清理數字都正常但 manifest 沒 commit 的情況光看數字分辨不出來
  if (summary.targets?.length) {
    const targetText = summary.targets
      .map(t => `• \`${t.bucket}\` 寫入 ${t.uploaded}、清理 ${t.deleted}、` +
        `${t.invalidated ? '已' : '未'}invalidate\n  ${manifestStatusText(summary, t)}`)
      .join('\n')
    embed.fields.push({
      name: '🪣 目標站台:',
      value: targetText.substring(0, 1024),
      inline: false
    })
  }

  const errorText = error || summarizeFailures(summary.failures)
  if (!success) {
    embed.fields.push({
      name: '❌ 錯誤訊息:',
      value: `\`\`\`${errorText || '沒有任何檔案寫入成功'}\`\`\``,
      inline: false
    })
  }

  return embed
}

/** 單一站台的 manifest commit 狀態（全域原因優先於 per-target 原因） */
function manifestStatusText(summary, target) {
  if (summary.manifestOk === false) return '⏭️ manifest 未 commit（抓取失敗/形狀不對）'
  if (summary.budgetExceeded) return '⏭️ manifest 未 commit（抓取時間預算用盡）'
  if (summary.monthIncomplete) return '⏭️ manifest 未 commit（月度檔不完整）'
  if (target.manifestSkipped) return `⏭️ manifest 未 commit（${target.manifestSkipReason || '該站台月度檔未寫入'}）`
  if (!target.uploaded) return '⏭️ manifest 未 commit（該站台沒有任何檔案寫入成功）'
  return '✅ manifest 已 commit'
}

/**
 * failures 分類截斷（快照通知專用）。
 * 直接 `join('\n').substring(0, 900)` 的問題：S3 出事時 failures 會被幾十行同構的
 * `bucket put xxx.json: AccessDenied` 灌滿，真正的關鍵結論（manifest 沒 commit、
 * 時間預算用盡）排在後面就被切掉了。故先分類、再依重要性各取前幾行。
 * @param {string[]} failures
 * @param {number} [maxChars] - 總長上限（Discord field value 1024，程式碼區塊另佔 6 字）
 */
function summarizeFailures(failures, maxChars = 900) {
  if (!failures?.length) return ''

  const MAX_PER_CATEGORY = 3
  const MAX_LINE = 200
  const categories = [
    { label: 'commit', match: f => /manifest|時間預算/.test(f) },
    { label: '抓取', match: f => /^[^\s:]+\.(json|md):/.test(f) || f.startsWith('setlist 全量') },
    { label: '上傳', match: f => / put /.test(f) },
    { label: '其他', match: () => true },   // cleanup / delete / invalidation / 站台層例外
  ]

  const groups = categories.map(() => [])
  for (const failure of failures) {
    const idx = categories.findIndex(c => c.match(failure))
    groups[idx === -1 ? categories.length - 1 : idx].push(failure)
  }

  const lines = []
  let used = 0
  const push = (text) => {
    if (used + text.length + 1 > maxChars) return false
    lines.push(text)
    used += text.length + 1
    return true
  }

  for (let i = 0; i < categories.length; i++) {
    const items = groups[i]
    if (!items.length) continue
    const label = categories[i].label
    let shown = 0
    for (const item of items.slice(0, MAX_PER_CATEGORY)) {
      if (!push(`[${label}] ${item}`.substring(0, MAX_LINE))) break
      shown++
    }
    if (shown < items.length) push(`[${label}] …同類另有 ${items.length - shown} 項`)
  }

  return lines.join('\n')
}

/**
 * 發送歌單留言到獨立的 Discord webhook
 * 使用 code block 顯示歌單，不觸發影片預覽
 * @param {string} webhookUrl - 歌單專用 webhook URL
 * @param {Object} stream - stream 物件（含 id, title, time）
 * @param {string} setlistComment - 原始歌單留言
 * @param {string} author - 留言作者
 */
/* ============================================================
 * MIGRATED to yt-setlist-discord stack (2026-05-02)
 * sendSetlistComment — 把抓到的歌單留言原文 POST 到 Discord
 * 已由 yt-setlist-discord 接管（cron 每 10 分鐘 polling）
 * ============================================================
export async function sendSetlistComment(webhookUrl, stream, setlistComment, author) {
  if (!webhookUrl) return

  // 支援逗號分隔多個 webhook URL
  const urls = typeof webhookUrl === 'string' ? webhookUrl.split(',').map(u => u.trim()).filter(Boolean) : [webhookUrl]
  if (urls.length === 0) return

  try {
    // <URL> 避免 Discord 產生影片預覽
    const url = `<https://www.youtube.com/watch?v=${stream.id}>`
    // 用 zero-width space 避免 Discord 標記到同名用戶（@ 後插入 \u200B）
    const safeAuthor = (author || '匿名').replace(/@/g, '@\u200B')
    // 格式化時間為 JST (UTC+9)
    let timeStr = ''
    if (stream.time) {
      const d = new Date(stream.time)
      timeStr = d.toLocaleString('en-US', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
      }) + ' (JST)'
    }
    const header = `${timeStr} ${stream.title || ''}\n${url}\n${safeAuthor}`
    const content = `${header}\n\`\`\`\n${setlistComment}\n\`\`\``
    const body = JSON.stringify({ content: content.substring(0, 2000) })

    await Promise.allSettled(urls.map(hookUrl =>
      fetch(hookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      })
    ))

    console.log(`Setlist comment sent to ${urls.length} Discord webhook(s)`)
  } catch (error) {
    console.error('Failed to send setlist comment to Discord:', error)
  }
}
============================================================ */

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
