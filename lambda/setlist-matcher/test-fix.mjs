// 驗證 matcher 修復的本地測試（連 production API 讀 songlist/aliases，唯讀）
// 涵蓋：多歌手括號切分、おじゃま虫Ⅱ(exact)、おじゃま虫2(序號感知)、無時間戳尾行過濾
process.env.BERRY_SITE_API_URL = 'https://m-b.win'
const { handler } = await import('./src/handler.js')

const comment = [
  '00:20:44 ~ 00:24:43 02| なぜ？謎？！ANSWER(Naze? Nazo?! ANSWER) | 熊田茜音(Kumada Akane) & 増井優花(Masui Yuka)',
  '01:13:56 ~ 01:18:22 13| おじゃま虫Ⅱ | DECO*27',
  '01:20:00 ~ 01:24:00 14| おじゃま虫 | DECO*27',
  '01:25:00 ~ 01:28:00 15| おじゃま虫2 | DECO*27',
  '01:29:00 ~ 01:32:00 16| おじゃま虫II | DECO*27',
  '01:33:00 ~ 01:36:00 17| ハロ/ハワユ(Hello/ how are you) | ほえほえP',  // 「/ 」在括號內不可切
  '01:37:00 ~ 01:40:00 ハロ/ハワユ(Hello/ how are you)',  // 無 | 行：主分隔裸 / 曾把曲名切爆
  '今日も最高だったよ～！',   // 無時間戳感想行 → 應被過濾，不出現在結果
].join('\n')

const expect = [
  { id: '1029', ajp: '熊田茜音 & 増井優花', aen: 'Kumada Akane & Masui Yuka' },
  { id: '142' },   // Ⅱ 全形 → exact
  { id: '141' },   // 無印不受影響
  { id: '142' },   // 半形 2 → 序號感知（與Ⅱ同序號、與無印不同序號）
  { id: '142' },   // 半形 II → 序號感知
  { id: '618' },   // 括號內斜線+空格不切（曾被切成「ハロ/ハワユ(Hello」判成新曲）
  { id: '618' },   // 無 | 行：主分隔 ' / ' 需兩側空格，含斜線曲名整行交給括號感知切分
]

const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ setlistComment: comment }) })
const body = JSON.parse(res.body)
if (!body.success) { console.error('FAIL:', body.error); process.exit(1) }

let pass = true
body.matches.forEach((m, i) => {
  const e = expect[i]
  const okId = e && String(m.finalSongID) === e.id
  if (!okId) pass = false
  console.log(`${okId ? 'OK ' : 'NG '} [${i}] songID=${m.finalSongID} (期望 ${e?.id ?? '不應出現'})`,
    '|', m.parsed.titleJP, '/', m.parsed.artistJP,
    '| match:', m.match.dbTitle ?? '*', m.match.score?.toFixed(3))
  if (e?.ajp && m.parsed.artistJP !== e.ajp) { pass = false; console.log(`    ^^ artistJP 期望「${e.ajp}」`) }
  if (e?.aen && m.parsed.artistEN !== e.aen) { pass = false; console.log(`    ^^ artistEN 期望「${e.aen}」`) }
})
if (body.matches.length !== expect.length) {
  pass = false
  console.log(`NG 行數 ${body.matches.length}，期望 ${expect.length}（感想行應被過濾）`)
}
console.log(pass ? '\n=== PASS ===' : '\n=== FAIL ===')
