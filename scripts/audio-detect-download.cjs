// 音訊批次下載器 — 序列執行（並發會壞，見 memory ytdlp-sabr-workaround）
// 讀 e:/tmp/audio_batch/batch.json，輸出 {id}.wav 到同目錄；已存在自動跳過（重跑=重試失敗項）
const { execFileSync } = require('child_process')
const fs = require('fs')

const DIR = 'e:/tmp/audio_batch'
const batch = JSON.parse(fs.readFileSync(`${DIR}/batch.json`, 'utf8'))

let ok = 0, fail = 0, skip = 0
const failures = []
const t0 = Date.now()
for (let i = 0; i < batch.length; i++) {
  const b = batch[i]
  const out = `${DIR}/${b.id}.wav`
  if (fs.existsSync(out)) { skip++; continue }
  const t1 = Date.now()
  try {
    execFileSync('python', [
      '-m', 'yt_dlp',
      `https://www.youtube.com/watch?v=${b.streamID}`,
      '--download-sections', `*${b.windowStart}-${b.windowEnd}`,
      '-f', 'bestaudio',
      '--js-runtimes', 'node',
      '-x', '--audio-format', 'wav',
      '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',
      '-o', `${DIR}/${b.id}.%(ext)s`,
      '--no-playlist', '-q', '--no-warnings',
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 480000 })
    ok++
    console.log(`[${i + 1}/${batch.length}] ${b.id} OK (${((Date.now() - t1) / 1000).toFixed(0)}s) 累計ok=${ok} fail=${fail} 總耗時${((Date.now() - t0) / 60000).toFixed(0)}m`)
  } catch (e) {
    fail++
    failures.push({ id: b.id, err: String(e.message).slice(0, 100) })
    console.log(`[${i + 1}/${batch.length}] ${b.id} FAIL 累計ok=${ok} fail=${fail}`)
  }
}
console.log(`\n完成: ok=${ok} fail=${fail} skip=${skip}`)
if (failures.length) fs.writeFileSync(`${DIR}/download_failures.json`, JSON.stringify(failures, null, 1))
