// 每頁 OG（分享預覽）meta 的資料表 —— build 後由 generate-og-html.mjs 產出
// `dist/og/<slug>.html`，內容是 index.html 只換掉 meta 的副本（SPA 照常掛載）。
//
// 為什麼要靜態產檔：Discord／X／LINE 的爬蟲**不執行 JS**，SPA 在瀏覽器端改 meta 對它們
// 完全無效。要讓「某張專輯／某套衣裝」的連結貼出去有各自的預覽圖與說明，只能在
// 伺服器端就把不同的 HTML 交出去 —— 兩站的接法各不相同：
//   ・AWS 主站：CloudFront Function（template.yaml 的 BotBlockerFunction）把
//     `/discography/rebirthr` rewrite 成 `/og/discography-rebirthr.html`
//   ・CF 備用站：entry-worker.js 直接向 ASSETS 取同一支檔（取不到才退回 index.html）
// 兩邊拿到的都是本腳本產的同一份檔案，不會有「兩套 meta 產生器」的分歧問題。
//
// 語言取日文（與 index.html 的靜態 OG、`<html lang="ja">` 一致）。
// og:url 一樣刻意不寫——demo 域 v3.m-b.win 與正式域 m-b.win 並存期會指錯。
//
// ⚠️ 資料來源是頁面自己的資料模組（discographyData.js／clothesData.js），
//    **兩支都必須維持「裸 Node 可 import」**（不吃 import.meta.env、不 import .svelte）。
//    新增專輯／衣裝只要照舊改資料模組，這裡與產檔會自動跟上；
//    AWS 側的 CloudFront Function 另有一份 id 清單要同步，見 scripts/check-routes.mjs。

import { releases, formatReleaseDate, ordinalSuffix } from '../src/pages/discographyData.js'
import { clothesData, formatClothesDate } from '../src/pages/clothesData.js'

export const SITE_NAME = '苺咲べりぃ非公式倉庫'

/** 圖片一律絕對 URL 指向主站（備用站／demo 站沒有自己的圖庫時也能顯示） */
const ORIGIN = 'https://m-b.win'

/**
 * 站台卡：`fansite/img/og/site.jpg`（＝index.html 的 og:image 同一張）。
 * 1200×630＝summary_large_image 的標準比例，各平台都不會再裁。
 */
const SITE_IMAGE = { url: `${ORIGIN}/img/og/site.jpg`, width: 1200, height: 630 }

/** 頁級卡：`fansite/img/og/{page}.jpg`，皆 1200×630（無專屬卡的頁走 SITE_IMAGE） */
const pageImage = (page) => ({ url: `${ORIGIN}/img/og/${page}.jpg`, width: 1200, height: 630 })

/**
 * 專輯／單曲封面：`fansite/img/albums/{id}.webp`，實測皆 520x520（peace 為 520x513，
 * 差 7px 不特別處理——寬高只是排版提示，平台仍會抓實檔）。
 * card 改 `summary`：正方形封面餵給 summary_large_image 會被裁成 1.91:1，切掉上下。
 */
const albumImage = (id) => ({ url: `${ORIGIN}/img/albums/${id}.webp`, width: 520, height: 520, card: 'summary' })

/**
 * 衣裝卡：`fansite/img/og/clothes/{date}.jpg`，每套一張 1200×630。
 * 立繪本身是 9:16 直式（直接當大圖卡會裁掉頭），故另做橫式卡——
 * 草莓牛奶底＋去背立繪置右＋左側衣裝名／お披露目日期，16 套一次產齊。
 */
const clothesImage = (date) => ({ url: `${ORIGIN}/img/og/clothes/${date}.jpg`, width: 1200, height: 630 })

/** 路徑 → 檔名 slug：`/discography/rebirthr` → `discography-rebirthr` */
export function ogSlug(path) {
  return path.replace(/^\//, '').replace(/\//g, '-')
}

/** 過長的說明截短（各平台約 150~200 字截斷，這裡自己收在 200 以內比被截得莫名其妙好） */
function clamp(text, max = 200) {
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

const title = (head) => `${head} | ${SITE_NAME}`

/** 頁級（總覽頁本身也值得有自己的說明，不然分享出去全是站台級文案） */
const PAGE_ENTRIES = [
  {
    path: '/discography',
    title: title('音楽作品'),
    description:
      '苺咲べりぃ(Maisaki Berry) のアルバム・シングル・参加楽曲の一覧。収録曲とスタッフ、歌枠での歌唱記録を作品ごとにまとめています。',
    image: pageImage('discography'),
  },
  {
    path: '/clothes',
    title: title('衣装'),
    description:
      '苺咲べりぃ(Maisaki Berry) の2D・3D衣装まとめ。立ち絵と表情差分、デザイン・モデリング担当、お披露目配信を衣装ごとに掲載。',
    image: pageImage('clothes'),
  },
  {
    path: '/profile',
    title: title('プロフィール'),
    description:
      '苺咲べりぃ(Maisaki Berry) のプロフィール。デビュー日・タグ・公式リンクなど、ファンサイト管理人がまとめた基本情報。',
    image: pageImage('profile'),
  },
  {
    path: '/setlist',
    title: title('セットリスト'),
    description:
      '苺咲べりぃ(Maisaki Berry) の歌枠セットリスト検索。曲名・アーティスト・配信日から探せて、各曲のアーカイブ再生位置（?t=）へ直接ジャンプできます。',
    image: SITE_IMAGE,
  },
]

/** 作品（専輯＋單曲）——曲目は上位3曲まで、残りは「ほか全N曲」に畳む */
function releaseEntry(work) {
  const kind = work.ordinal ? `${ordinalSuffix(work.ordinal)}アルバム` : 'シングル'
  const names = work.tracks.map((tr) => tr.name)
  const shown = names.slice(0, 3).join('／')
  const trackText = names.length > 3 ? `${shown} ほか全${names.length}曲` : shown
  return {
    path: `/discography/${work.id}`,
    title: title(`${work.title}（${kind}）`),
    description: clamp(
      `苺咲べりぃ(Maisaki Berry) ${kind}「${work.title}」${formatReleaseDate(work.releaseDate, 'ja')}発売。` +
        `収録曲：${trackText}。製作スタッフと歌枠での歌唱記録も掲載。`,
    ),
    image: albumImage(work.id),
  }
}

/** 衣裝 */
function clothesEntry(item) {
  return {
    path: `/clothes/${item.date}`,
    title: title(item.name),
    description: clamp(
      `苺咲べりぃ(Maisaki Berry) の衣装「${item.name}」${formatClothesDate(item.date, 'ja')}お披露目。` +
        `デザイン：${item.designer}／モデリング：${item.modeler}。立ち絵・表情差分・お披露目配信を掲載。`,
    ),
    image: clothesImage(item.date),
  }
}

/**
 * 產檔清單。每筆：{ path, slug, title, description, image:{url,width,height,card?} }
 * 順序＝頁級 → 作品 → 衣裝（產檔順序不影響行為，只影響 log 好不好讀）。
 */
export const OG_ENTRIES = [
  ...PAGE_ENTRIES,
  ...releases.map(releaseEntry),
  ...clothesData.map(clothesEntry),
].map((e) => ({ ...e, slug: ogSlug(e.path) }))

/**
 * 動態段路由的項目 id 清單（前綴 → id[]）。
 * AWS 的 CloudFront Function 需要內嵌同一份（它看不到 S3 上有沒有那支檔，
 * 只能靠清單決定要不要 rewrite 成 og 檔）——一致性由 scripts/check-routes.mjs 把關。
 */
export const OG_ITEM_IDS = {
  '/discography': releases.map((w) => w.id),
  '/clothes': clothesData.map((it) => it.date),
}
