import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

// 本地 dev 時 /api 與 /tb 代理到目標後端：
//   預設 production（唯讀瀏覽 demo）；要測編輯功能時走 testdb 模式
//   （npm run dev:testdb → 本地後端＋測試 DB）或設 BERRY_API
export default defineConfig(({ mode }) => {
  const apiTarget =
    process.env.BERRY_API || (mode === 'testdb' ? 'http://localhost:8788' : 'https://m-b.win')
  return defineBase(apiTarget)
})

const defineBase = (apiTarget) => ({
  plugins: [svelte(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/tb': { target: apiTarget, changeOrigin: true },
      // 沿用現站線上靜態資源（衣裝/profile 圖、BGM）
      // 部署時這些資源會與新站同 bucket，屆時本節可移除
      // （history.md / changelog.json 已改走 public/data/ 快照，見 scripts/fetch-snapshot.mjs）
      '/img': { target: 'https://m-b.win', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
  },
})
