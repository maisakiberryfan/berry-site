// 圖片/音訊資源 URL：
// dev 時直連線上站（vite proxy 轉發大檔既慢又失真——瀏覽器 <img> 不受 CORS 限制，直連即可）
// 部署後與站同源 CDN 直出，回歸相對路徑
export const assetUrl = (path) => (import.meta.env.DEV ? `https://m-b.win${path}` : path)
