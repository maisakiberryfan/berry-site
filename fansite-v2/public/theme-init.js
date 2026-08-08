// 首繪前同步套用主題，防閃爍（CSP 禁 inline，獨立成檔）
// 優先序：?theme= 測試 override（不落地）> localStorage > 系統 prefers-color-scheme > light
// localStorage key 'theme' 沿用現站，偏好互通
(function () {
  var qs = new URLSearchParams(location.search).get('theme');
  var stored = null;
  try { stored = localStorage.getItem('theme'); } catch (e) {}
  var theme = (qs === 'dark' || qs === 'light') ? qs
    : (stored === 'dark' || stored === 'light') ? stored
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark'
    : 'light';
  document.documentElement.dataset.theme = theme;
})();
