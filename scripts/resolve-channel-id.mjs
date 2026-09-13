#!/usr/bin/env node
// 把 YouTube @handle 轉成頻道 ID，供 config.js 的 preferredAuthorChannelId 填值用。
// 留言 API 的 authorDisplayName 就是作者當下的 @handle，改名字串就對不上；頻道 ID 不變。
//
//   node scripts/resolve-channel-id.mjs @KLバカ
//   node scripts/resolve-channel-id.mjs https://www.youtube.com/@KLバカ
//
// 金鑰：process.env.YOUTUBE_API_KEY 優先，缺值時 fallback 讀 repo 根 .env（同 db-config.cjs）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

function loadDotenv() {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const p of [join(process.cwd(), '.env'), join(here, '..', '.env')]) {
    try {
      const txt = readFileSync(p, 'utf8')
      return Object.fromEntries(txt.split(/\r?\n/)
        .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]))
    } catch {}
  }
  return {}
}

const input = process.argv[2]
if (!input) {
  console.error('用法: node scripts/resolve-channel-id.mjs @handle')
  process.exit(2)
}
const handle = (input.match(/youtube\.com\/@([^/?#]+)/)?.[1] ?? input).replace(/^@/, '')

const apiKey = process.env.YOUTUBE_API_KEY || loadDotenv().YOUTUBE_API_KEY
if (!apiKey) {
  console.error('YOUTUBE_API_KEY not found — set env var or provide .env at repo root')
  process.exit(2)
}

const params = new URLSearchParams({ part: 'id,snippet', forHandle: handle, key: apiKey })
const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?${params}`)
const data = await res.json()
if (!res.ok) {
  console.error(`YouTube API 錯誤: ${data?.error?.message || res.status}`)
  process.exitCode = 1
} else if (!data.items?.[0]) {
  console.error(`找不到 @${handle}（已改名？）`)
  process.exitCode = 1
} else {
  const ch = data.items[0]
  console.log(`@${ch.snippet?.customUrl?.replace(/^@/, '') ?? handle}  ${ch.snippet?.title ?? ''}`)
  console.log(`preferredAuthorChannelId: '${ch.id}'`)
}
