// 亮暗主題切換
//
// localStorage key 'theme' 沿用現站（值 'light' / 'dark'），首繪前的套用在
// public/theme-init.js（head 內同步 script，防閃爍）。本模組只負責「切換」與
// 「目前值的 reactive 讀取」，屬性名為 data-theme（app.css 的 dark variant 依據）。

const STORAGE_KEY = 'theme'

function readCurrent() {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

let current = $state(readCurrent())

export const theme = {
  get value() {
    return current
  },
  get isDark() {
    return current === 'dark'
  },
}

export function getTheme() {
  return current
}

export function setTheme(next) {
  const value = next === 'dark' ? 'dark' : 'light'
  current = value
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = value
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* 私密視窗等：切換仍生效，只是不記憶 */
  }
}

export function toggleTheme() {
  setTheme(current === 'dark' ? 'light' : 'dark')
}
