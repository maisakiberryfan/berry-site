/**
 * 連結 scheme 白名單 —— 只允許 http(s) 與站內絕對路徑，擋掉 javascript:/data: 等注入。
 *
 * ⚠️ `\/(?![/\\])`：單一斜線開頭才算站內路徑。
 *    `//evil.com`（protocol-relative）與 `/\evil.com`（WHATWG URL 解析器把 `\` 當 `/`）
 *    都會被瀏覽器解成外站絕對網址，白名單放行等於開了外連後門。
 *
 * ⚠️ **先剝掉 tab/CR/LF 再驗，且回傳剝過的字串**：WHATWG URL 解析器會無條件移除 URL 中的
 *    這三種字元，所以 `/<TAB>/evil.com` 在瀏覽器眼中就是 `//evil.com`（protocol-relative
 *    外連）、`java<LF>script:alert(1)` 就是 `javascript:`——不先正規化，白名單看到的字串
 *    與瀏覽器實際解析的目標不是同一個東西，等於留了一條繞道。回傳正規化後的值是為了讓
 *    「驗到的」與「用到的」逐字相同（回傳原字串則兩者仍可能分歧）。
 *    其餘空白（含前導空格）不剝：`^` 錨點會讓它們直接落空 ⇒ 判為不安全，方向是安全的。
 *
 * 用於 history.md 解析（lib/content/markdown.js）與首頁 changelog 的 inline 連結
 * （lib/home/util.js）——兩處曾各留一份逐字相同的實作，已收斂到這裡。
 *
 * @param {unknown} url
 * @returns {string|null} 通過白名單回正規化後的字串，否則 null（呼叫端退回純文字呈現）
 */
export function safeHref(url) {
  const s = String(url ?? '').replace(/[\t\r\n]/g, '')
  return /^(https?:\/\/|\/(?![/\\]))/i.test(s) ? s : null
}
