// 主題初始化：必須以「同步 script」在 head 載入（阻塞首繪，避免主題閃爍）。
// CSP script-src 'self' 禁 inline script，故獨立成檔。
// 優先序：URL ?theme=（測試用，不落地）> localStorage > 預設 light
(function () {
  var t = null
  try {
    t = new URLSearchParams(location.search).get('theme')
    if (t !== 'light' && t !== 'dark') t = localStorage.getItem('theme')
  } catch (e) { /* localStorage 不可用時走預設 */ }
  if (t !== 'light' && t !== 'dark') t = 'light'
  document.documentElement.setAttribute('data-bs-theme', t)
})()
