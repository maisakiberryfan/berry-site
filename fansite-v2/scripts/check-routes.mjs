#!/usr/bin/env node
// 路由／OG 白名單一致性檢查 —— `npm run check:routes`
//
// 這個站的路由白名單有四份（無法 import 共用：Workers bundle 只含後端 src/，
// CloudFront Function 是 template.yaml 裡的內嵌字串，兩者都不在前端的模組圖裡），
// 外加 OG 快照的 id 清單一份。人工同步遲早會漏，於是把「比對」自動化：
//
//   1. src/router.svelte.js 的 ROUTES        —— 站內連結清單的單一真相
//   2. src/App.svelte 的 PAGES               —— 決定渲染哪個頁面元件
//   3. ../template.yaml 的 spaRoutes/spaPrefixes/ogPages/ogClothes/ogDisco（AWS）
//   4. ../entry-worker.js 的 SPA_ROUTES/SPA_PREFIXES/OG_PAGES（CF 備用站）
//   5. scripts/og-config.mjs 的 OG_ITEM_IDS  —— OG 產檔清單（真相＝各頁的資料模組）
//
// 判讀規則：
//   ・1~4 的「路由」不一致 ⇒ **錯誤**（漏一處就是 F5 壞掉／soft-404 這種硬傷）
//   ・3 的 og id 清單與 5 不一致 ⇒ **錯誤**（AWS 那份是手抄的，最容易走鐘；
//     漏更新雖然只是該項目退回站台級預覽，但那正是這支腳本存在的理由）
//
// 退出碼：0 全部一致；1 有不一致（訊息會指名是哪一份、缺了什麼）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OG_ITEM_IDS, OG_ENTRIES } from './og-config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const v2 = path.resolve(here, '..')
const repo = path.resolve(v2, '..')

const read = (p) => fs.readFileSync(p, 'utf8')
const problems = []
const fail = (msg) => problems.push(msg)

/** 取出 `const/var NAME = [ ... ]` 或 `new Set([...])` 內的單引號字串 */
function stringList(source, declRe, label) {
  const m = source.match(declRe)
  if (!m) {
    fail(`${label}：找不到宣告（正則沒對上，檔案結構可能被改過）`)
    return null
  }
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
}

const same = (a, b, label) => {
  if (!a || !b) return
  const missing = b.filter((x) => !a.includes(x))
  const extra = a.filter((x) => !b.includes(x))
  if (missing.length || extra.length) {
    fail(`${label}\n    缺少：${missing.join(', ') || '（無）'}\n    多出：${extra.join(', ') || '（無）'}`)
  }
}

// ── 1. router.svelte.js 的 ROUTES ───────────────────────────────────────────
const routerSrc = read(path.join(v2, 'src/router.svelte.js'))
const ROUTES = stringList(routerSrc, /export const ROUTES = \[([\s\S]*?)\]/, 'router ROUTES') ?? []
const staticRoutes = ROUTES.filter((r) => !r.endsWith('/:id'))
const dynamicPrefixes = ROUTES.filter((r) => r.endsWith('/:id')).map((r) => r.slice(0, -'/:id'.length))

// ── 2. App.svelte 的 PAGES ──────────────────────────────────────────────────
const appSrc = read(path.join(v2, 'src/App.svelte'))
const pagesBlock = appSrc.match(/const PAGES = \{([\s\S]*?)\n  \}/)
if (!pagesBlock) fail('App.svelte PAGES：找不到宣告')
const PAGES = pagesBlock ? [...pagesBlock[1].matchAll(/'([^']*)':/g)].map((x) => x[1]) : []
same(PAGES, ROUTES, 'App.svelte 的 PAGES 與 router 的 ROUTES 不一致')

// ── 3. template.yaml（AWS CloudFront Function）──────────────────────────────
const tplSrc = read(path.join(repo, 'template.yaml'))
same(
  stringList(tplSrc, /var spaRoutes = \[([\s\S]*?)\]/, 'template spaRoutes'),
  staticRoutes,
  'template.yaml 的 spaRoutes 與 router 的靜態 ROUTES 不一致',
)
same(
  stringList(tplSrc, /var spaPrefixes = \[([\s\S]*?)\]/, 'template spaPrefixes'),
  dynamicPrefixes,
  'template.yaml 的 spaPrefixes 與 router 的動態段前綴不一致',
)

// ── 4. entry-worker.js（CF 備用站）──────────────────────────────────────────
const workerSrc = read(path.join(repo, 'entry-worker.js'))
same(
  stringList(workerSrc, /const SPA_ROUTES = new Set\(\[([\s\S]*?)\]\)/, 'worker SPA_ROUTES'),
  staticRoutes,
  'entry-worker.js 的 SPA_ROUTES 與 router 的靜態 ROUTES 不一致',
)
same(
  stringList(workerSrc, /const SPA_PREFIXES = new Set\(\[([\s\S]*?)\]\)/, 'worker SPA_PREFIXES'),
  dynamicPrefixes,
  'entry-worker.js 的 SPA_PREFIXES 與 router 的動態段前綴不一致',
)

// ── 5. OG 清單：頁級 ────────────────────────────────────────────────────────
const ogPagesConfig = OG_ENTRIES.filter((e) => !e.path.slice(1).includes('/')).map((e) => e.path)
same(stringList(tplSrc, /var ogPages = \[([\s\S]*?)\]/, 'template ogPages'), ogPagesConfig, 'template.yaml 的 ogPages 與 og-config 的頁級項目不一致')
same(
  stringList(workerSrc, /const OG_PAGES = new Set\(\[([\s\S]*?)\]\)/, 'worker OG_PAGES'),
  ogPagesConfig,
  'entry-worker.js 的 OG_PAGES 與 og-config 的頁級項目不一致',
)

// ── 5b. OG 清單：項目級 id（只有 AWS 那側需要內嵌）──────────────────────────
function pipeList(varName, label) {
  const m = tplSrc.match(new RegExp(`var ${varName} = '([^']*)'`))
  if (!m) {
    fail(`${label}：找不到宣告`)
    return null
  }
  return m[1].split('|').filter(Boolean)
}
same(pipeList('ogClothes', 'template ogClothes'), OG_ITEM_IDS['/clothes'], 'template.yaml 的 ogClothes 與 clothesData 不一致')
same(pipeList('ogDisco', 'template ogDisco'), OG_ITEM_IDS['/discography'], 'template.yaml 的 ogDisco 與 discographyData 不一致')

// ── 結果 ────────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error('✗ 白名單不一致：\n')
  for (const p of problems) console.error(`  ・${p}`)
  console.error('\n  修法：以 fansite-v2 側為真相，把上列清單補齊（改 template.yaml 需重新 sam deploy）')
  process.exit(1)
}
console.log(
  `✓ 白名單一致：路由 ${staticRoutes.length} 靜態 ＋ ${dynamicPrefixes.length} 動態前綴、` +
    `OG 快照 ${OG_ENTRIES.length} 支（頁級 ${ogPagesConfig.length}）`,
)
