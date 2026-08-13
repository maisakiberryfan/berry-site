import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 本地 dev 時 /api 與 /tb 代理到目標後端：
//   預設 production（唯讀瀏覽 demo）；要測編輯功能時走 testdb 模式
//   （npm run dev:testdb → 本地後端＋測試 DB）或設 BERRY_API
export default defineConfig(({ mode }) => {
  const apiTarget =
    process.env.BERRY_API || (mode === 'testdb' ? 'http://localhost:8788' : 'https://m-b.win')
  return defineBase(apiTarget)
})

// dev 的 /img 先讀本地 ../fansite/img（部署來源，clothes/profile/albums 都在 repo——
// 剛加的圖不用等部署就看得到，也比直連線上快）；本地沒有的檔 fallthrough 給 proxy
const IMG_TYPES = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' }
const localFansiteImg = () => ({
  name: 'serve-local-fansite-img',
  configureServer(server) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fansite/img')
    server.middlewares.use('/img', (req, res, next) => {
      const rel = decodeURIComponent((req.url || '').split('?')[0])
      const file = path.join(root, rel)
      if (!file.startsWith(root)) return next()
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return next()
        res.setHeader('Content-Type', IMG_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream')
        fs.createReadStream(file).pipe(res)
      })
    })
  },
})

const defineBase = (apiTarget) => ({
  plugins: [svelte(), tailwindcss(), localFansiteImg()],
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
