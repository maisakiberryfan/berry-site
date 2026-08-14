/**
 * 連結 scheme 白名單 —— 只允許 http(s) 與站內絕對路徑，擋掉 javascript:/data: 等注入。
 *
 * ⚠️ `\/(?![/\\])`：單一斜線開頭才算站內路徑。
 *    `//evil.com`（protocol-relative）與 `/\evil.com`（WHATWG URL 解析器把 `\` 當 `/`）
 *    都會被瀏覽器解成外站絕對網址，白名單放行等於開了外連後門。
 *
 * 用於 history.md 解析（lib/content/markdown.js）與首頁 changelog 的 inline 連結
 * （lib/home/util.js）——兩處曾各留一份逐字相同的實作，已收斂到這裡。
 *
 * @param {unknown} url
 * @returns {string|null} 通過白名單回原字串，否則 null（呼叫端退回純文字呈現）
 */
export function safeHref(url) {
  const s = String(url ?? '')
  return /^(https?:\/\/|\/(?![/\\]))/i.test(s) ? s : null
}
