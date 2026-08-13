// 圖片/音訊資源 URL 前綴：
// - dev：相對路徑——vite 的 localFansiteImg middleware 先讀本地 ../fansite/img
//   （部署來源就在 repo，新圖即刻可見），沒有的檔才由 /img proxy 轉發線上
// - v3 demo 部署（獨立子網域）：build 時設 VITE_ASSET_BASE=https://m-b.win 沿用主站圖片
// - 正式上線（與主站同源）：不設 → 相對路徑
const BASE = import.meta.env.VITE_ASSET_BASE ?? ''
export const assetUrl = (path) => BASE + path
