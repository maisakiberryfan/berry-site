import { spawn } from 'child_process'
import { setTimeout } from 'timers/promises'

const SAM_PORT = 3000
const HEALTH_CHECK_URL = `http://localhost:${SAM_PORT}/match-setlist`

async function waitForServer(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(HEALTH_CHECK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
      // 400 = 驗證錯誤，表示 Lambda 已啟動
      if (response.status === 400 || response.status === 200) {
        return true
      }
    } catch {
      // 連線失敗，繼續等待
    }
    await setTimeout(1000)
    process.stdout.write('.')
  }
  return false
}

console.log('🚀 Starting SAM Local...')
console.log('📋 Local config: Timeout=180s, Memory=512MB')

const sam = spawn('sam', [
  'local', 'start-api',
  '-n', 'env.json',
  '--parameter-overrides', 'FunctionTimeout=180 FunctionMemory=512'
], {
  stdio: 'inherit',
  shell: true
})

// 等待 SAM 啟動
console.log('\n⏳ Waiting for Lambda to be ready...')
await setTimeout(3000) // 先等 3 秒讓 SAM 啟動

const ready = await waitForServer()

if (ready) {
  console.log('\n✅ Lambda is ready! Environment variable logged above.')
} else {
  console.log('\n⚠️ Could not verify Lambda startup')
}

// 保持運行
sam.on('close', (code) => {
  process.exit(code)
})
