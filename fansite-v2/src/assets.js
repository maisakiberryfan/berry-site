// 圖片/音訊資源 URL 前綴：
// - dev：直連線上站（vite proxy 轉發大檔既慢又失真——瀏覽器 <img> 不受 CORS 限制）
// - v3 demo 部署（獨立子網域）：build 時設 VITE_ASSET_BASE=https://m-b.win 沿用主站圖片
// - 正式上線（與主站同源）：不設 → 相對路徑
const BASE = import.meta.env.VITE_ASSET_BASE ?? (import.meta.env.DEV ? 'https://m-b.win' : '')
export const assetUrl = (path) => BASE + path
