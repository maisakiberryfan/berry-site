#!/usr/bin/env node
// build 後產生每頁的 OG 快照：`dist/og/<slug>.html`
//
// 作法：讀 `dist/index.html`，只替換 head 內的 og:title / og:description / og:image
// （＋width/height）／twitter:card 與 `meta name="description"`，其餘一字不動 ——
// 產物仍是完整的 SPA 入口（script/link 都是絕對路徑 `/assets/...`），
// 被 rewrite 到這支檔的訪客照樣得到正常網站，差別只在爬蟲讀得到的那幾行 meta。
//
// 兩站怎麼用到它，見 scripts/og-config.mjs 檔頭。
//
// 用法：
//   node scripts/generate-og-html.mjs            # 產檔（npm run build 已串上）
//   node scripts/generate-og-html.mjs --dist X   # 指定 dist 目錄
//
// 失敗即 exit 1：這支跑在 vite build 之後，產不出來就代表 index.html 的 meta 結構
// 被改過（例如少了 og:image:width），靜默略過只會讓分享預覽在沒人發現的情況下退回站台級。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OG_ENTRIES } from './og-config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const argDist = process.argv.indexOf('--dist')
const distDir = argDist >= 0 ? path.resolve(process.argv[argDist + 1]) : path.resolve(here, '../dist')
const outDir = path.join(distDir, 'og')

/** HTML 屬性值轉義（曲名裡有 & 或引號時不會炸掉 meta） */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 換掉某個 meta 的 content。
 * 找不到或找到多個都直接拋——index.html 的 meta 結構是這支腳本的唯一前提，
 * 靜默略過等於產出「看起來成功、其實沒換」的檔。
 */
function replaceMeta(html, attr, name, value) {
  const pattern = new RegExp(`(<meta\\s+${attr}="${name}"\\s+content=")([^"]*)(")`, 'g')
  const hits = html.match(pattern)
  if (!hits) throw new Error(`index.html 找不到 <meta ${attr}="${name}" content="...">`)
  if (hits.length > 1) throw new Error(`index.html 有 ${hits.length} 個 <meta ${attr}="${name}">，無法決定要換哪個`)
  return html.replace(pattern, `$1${escapeAttr(value)}$3`)
}

function buildHtml(indexHtml, entry) {
  let html = indexHtml
  html = replaceMeta(html, 'name', 'description', entry.description)
  html = replaceMeta(html, 'property', 'og:title', entry.title)
  html = replaceMeta(html, 'property', 'og:description', entry.description)
  html = replaceMeta(html, 'property', 'og:image', entry.image.url)
  html = replaceMeta(html, 'property', 'og:image:width', entry.image.width)
  html = replaceMeta(html, 'property', 'og:image:height', entry.image.height)
  if (entry.image.card) html = replaceMeta(html, 'name', 'twitter:card', entry.image.card)
  return html
}

function main() {
  const indexPath = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexPath)) {
    console.error(`✗ 找不到 ${indexPath} —— 請先跑 vite build`)
    process.exit(1)
  }
  const indexHtml = fs.readFileSync(indexPath, 'utf8')

  // 全量重產：舊 slug（改名／刪除的作品）不該留在 dist 裡被同步上去
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const seen = new Set()
  for (const entry of OG_ENTRIES) {
    if (seen.has(entry.slug)) throw new Error(`og slug 重複：${entry.slug}（${entry.path}）`)
    seen.add(entry.slug)
    fs.writeFileSync(path.join(outDir, `${entry.slug}.html`), buildHtml(indexHtml, entry))
  }

  console.log(`✓ OG 快照 ${seen.size} 支 → ${path.relative(process.cwd(), outDir)}/`)
}

try {
  main()
} catch (err) {
  console.error(`✗ OG 快照產生失敗：${err.message}`)
  process.exit(1)
}
