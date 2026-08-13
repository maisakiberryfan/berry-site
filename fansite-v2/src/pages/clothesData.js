// 衣裝資料 —— 照搬自 fansite/assets/js/clothes.js 的 sourceArray（唯讀資料模組）。
// 欄位：
//   name       衣裝名稱（開頭 "2D-"/"3D-" 決定分類，沿用現站判斷方式）
//   date       發表日 YYYYMMDD（同時是圖片資料夾名 img/clothes/{date}/）
//   designer   設計
//   modeler    建模
//   link       發表直播的 YouTube video ID
//   count      立繪張數（s1..sN）
//   tCount     表情差分張數（t1..tN，0 = 無）
//   sideView   四面圖張數（c1..cN，缺省 = 無）
export const clothesData = [
  { name: '3D-にゃんにゃん衣装', date: '20260611', designer: 'ぬこ', modeler: 'REI', link: 'Gh6AsG8DmCI', count: 5, tCount: 0, sideView: 1 },
  { name: '2D-冬服', date: '20260212', designer: 'みわうに', modeler: 'うなぬん', link: 'OraWP0bLPfY', count: 4, tCount: 0 },
  { name: '2D-アイドル衣装3', date: '20250526', designer: 'みわうに', modeler: 'うなぬん', link: '9G0RAa5cOlY', count: 5, tCount: 0 },
  { name: '2D-JK服', date: '20250120', designer: 'みわうに', modeler: '乃樹坂くしお', link: 's8xse8ghpTw', count: 7, tCount: 9 },
  { name: '3D-衣装4', date: '20241205', designer: 'ana', modeler: 'Rぷりん', link: 'tXgcfNdmL84', count: 8, tCount: 9, sideView: 2 },
  { name: '2D-和服メイド', date: '20240617', designer: 'みわうに', modeler: '乃樹坂くしお', link: 'x4_vih6njco', count: 6, tCount: 9 },
  { name: '2D-ルームウェア', date: '20240116', designer: 'みわうに', modeler: '乃樹坂くしお', link: '_puahGBIXPs', count: 8, tCount: 9 },
  { name: '3D-衣装3', date: '20230905', designer: 'ana', modeler: 'Rぷりん', link: '61TdPwpqekc', count: 7, tCount: 9, sideView: 2 },
  { name: '2D-新衣装', date: '20230515', designer: 'みわうに', modeler: '乃樹坂くしお', link: 'LZPbxTodH7M', count: 5, tCount: 9 },
  { name: '2D-アイドル衣装2', date: '20220905', designer: 'みわうに', modeler: 'クワガタ', link: '42suuMXG2Gw', count: 5, tCount: 9 },
  { name: '3D-衣装2', date: '20220815', designer: 'ana', modeler: 'REI', link: 'k7dberaRllk', count: 6, tCount: 9, sideView: 2 },
  { name: '2D-衣装', date: '20220515', designer: 'みわうに', modeler: 'わくー。', link: '-UNwTux9VSw', count: 6, tCount: 9 },
  { name: '2D-アイドル衣装1', date: '20210910', designer: 'みわうに', modeler: 'わくー。', link: 'mqIXh62KGoo', count: 5, tCount: 9 },
  { name: '3D-衣装1', date: '20210724', designer: 'ana', modeler: 'REI', link: 'Tv-B6rqKhMU', count: 6, tCount: 9, sideView: 2 },
  { name: '2D-ver1.5', date: '20210213', designer: 'ケイ', modeler: 'わくー。', link: 'RQC8Af2TWHc', count: 1, tCount: 0 },
  { name: '2D-初期衣装', date: '20200815', designer: 'ケイ', modeler: 'わくー。', link: 'DkoSEEItb5Y', count: 1, tCount: 0 },
]

/** 2D/3D 分類：沿用現站判斷方式（name 開頭字串） */
export function clothesDim(item) {
  return item.name.startsWith('3D') ? '3D' : '2D'
}

/** YYYYMMDD → YYYY/MM/DD */
export function formatClothesDate(d) {
  return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`
}

/** 產生某套衣裝某系列（s/t/c）圖片的 Lightbox 用陣列 */
import { assetUrl } from '../assets.js'
export function clothesGalleryImages(item, prefix, count) {
  return Array.from({ length: count }, (_, i) => ({
    src: assetUrl(`/img/clothes/${item.date}/${prefix}${i + 1}.webp`),
    alt: `${item.name} ${prefix}${i + 1}`,
  }))
}
