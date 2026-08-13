// 三語系統（zh / en / ja）
//
// localStorage key 'lang' 沿用現站（與現站偏好互通）。
// 偵測順序：localStorage → navigator.language（zh*→zh、ja*→ja、其他→en）。
//
// 用法（元件內）：
//   import { t, lang, setLang } from '../i18n.svelte.js'
//   <h1>{t('page.songlist')}</h1>       ← t() 讀 lang，語言切換時自動重繪
//   {t('common.rowCount', { n: rows.length })}

import zh from './i18n/zh.js'
import en from './i18n/en.js'
import ja from './i18n/ja.js'

const DICTS = { zh, en, ja }
// 選單順序：中→日→英（受眾以中文、日文圈為主）
export const LANGS = ['zh', 'ja', 'en']
export const LANG_LABELS = { zh: '中文', en: 'English', ja: '日本語' }

const STORAGE_KEY = 'lang'
const FALLBACK = 'zh'

// <html lang> 的值（zh 是繁體，要寫 zh-Hant）
const HTML_LANG = { zh: 'zh-Hant', ja: 'ja', en: 'en' }

// meta description 的三語版本。
// 只服務瀏覽器層面（分頁翻譯提示、書籤摘要）——SEO/分享預覽的爬蟲不執行 JS，
// 吃的是 index.html 裡的靜態日文值，改這裡時記得兩邊語意保持一致。
// 放模組常數而非共享字典：這是 document metadata，不是畫面上的 UI 文案。
const META_DESCRIPTION = {
  zh: '苺咲べりぃ(Maisaki Berry) 非官方粉絲網站。歌回歌單、歌曲資料庫、直播紀錄查詢。',
  ja: '苺咲べりぃ(Maisaki Berry) の非公式ファンサイト。歌枠のセットリスト・楽曲データベース・配信アーカイブを検索できます。',
  en: 'Unofficial fan site for VTuber Maisaki Berry — singing stream setlists, song database and stream archive.',
}

/** 把語言反映到 document 上（<html lang> ＋ meta description） */
function applyDocumentLang(code) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = HTML_LANG[code] ?? code
  const meta = document.querySelector('meta[name="description"]')
  if (meta && META_DESCRIPTION[code]) meta.setAttribute('content', META_DESCRIPTION[code])
}

function detect() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && LANGS.includes(stored)) return stored
  } catch {
    /* 私密視窗等：忽略 */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : ''
  if (/^zh/i.test(nav)) return 'zh'
  if (/^ja/i.test(nav)) return 'ja'
  return 'en'
}

const initial = detect()
let current = $state(initial)

export const lang = {
  get value() {
    return current
  },
}

/** 目前語言（reactive；在元件的 reactive 位置讀取才會追蹤） */
export function getLang() {
  return current
}

export function setLang(next) {
  if (!LANGS.includes(next) || next === current) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* ignore */
  }
  applyDocumentLang(next)
}

function lookup(dict, path) {
  let node = dict
  for (const part of path) {
    if (node == null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return typeof node === 'string' ? node : undefined
}

/**
 * 取字串。找不到時退回 zh，再找不到就回 key 本身（開發期一眼看得出缺字）。
 * params 以 {name} 佔位插值。
 */
export function t(key, params) {
  const path = key.split('.')
  const text = lookup(DICTS[current], path) ?? lookup(DICTS[FALLBACK], path) ?? key
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
}

/** nav.js / 靜態資料的 label / labelEn / labelJa 三語欄位取值（缺省 fallback label） */
export function pickLabel(item) {
  if (!item) return ''
  if (current === 'en') return item.labelEn || item.label || ''
  if (current === 'ja') return item.labelJa || item.label || ''
  return item.label || ''
}

// 首次載入時把 document 對齊偵測結果（用 initial，避免讀 $state 觸發 state_referenced_locally）
applyDocumentLang(initial)
