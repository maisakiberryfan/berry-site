// 回歸測試：Gh6AsG8DmCI 的 KL 留言全文，14 首已知 songID（production 6/12 重解析結果）
process.env.BERRY_SITE_API_URL = 'https://m-b.win'
const { handler } = await import('./src/handler.js')

const comment = `♬セトリ/Set List♬

00:01:38 ~ 00:05:11 01| KAWAII♥Shooting！| 苺咲べりぃ(Maisaki Berry)
00:05:14 ~ 00:09:20 02| Emotion | 苺咲べりぃ(Maisaki Berry)
00:11:54 ~ 00:16:08 03| innoecnec | 苺咲べりぃ(Maisaki Berry)
00:16:11 ~ 00:20:25 04| レプリカ(Repurika)| 苺咲べりぃ(Maisaki Berry)
00:20:27 ~ 00:24:08 05| しらないうた(Shiranaiuta) | 苺咲べりぃ(Maisaki Berry)
00:28:10 ~ 00:34:06 06| Wishing | 水瀬いのり(Minase inori)
00:34:11 ~ 00:39:05 07| アムリタ(Amurita) | 牧野由依(Yui makino)
00:39:11 ~ 00:44:32 08| 115万キロのフィルム(115 million kilometer film) | Official髭男dism(Ofisharu higedan dhizumu)
00:49:53 ~ 00:54:39 09| One Love | 嵐(arashi)
00:54:42 ~ 00:58:39 10| MAGIC| 愛内里菜(Aiuchirina)

00:58:42 ~ 01:03:11 11| 夜空(Yozora) | 鈴木みのり(Minori Suzuki)
01:10:24 ~ 01:13:55 12| 星へ伸ばす手(Hoshi e Nobasu Te) | 苺咲べりぃ(Maisaki Berry)
01:13:56 ~ 01:18:22 13| アオハルを | 苺咲べりぃ(Maisaki Berry)
01:27:32 ~ 01:31:27 14| 全肯定ハピハピキュートSTORY！(zenkoutei happy happy cute story) | 苺咲べりぃ(Maisaki Berry)


 新衣装かわいいね`

const expected = ['1023','120','935','938','936','104','30','641','905','752','852','734','1036','433']

const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ setlistComment: comment }) })
const body = JSON.parse(res.body)
if (!body.success) { console.error('FAIL:', body.error); process.exit(1) }

let pass = true
body.matches.forEach((m, i) => {
  const exp = expected[i] ?? '(超出已知清單)'
  const ok = String(m.finalSongID) === exp
  if (!ok) pass = false
  console.log(`${ok ? 'OK ' : 'NG '} [${i}] ${m.finalSongID} (期望 ${exp}) | ${m.parsed.titleJP} / ${m.parsed.artistJP}`)
})
console.log(`共解析 ${body.matches.length} 行（期望 ${expected.length} 首 + 可能的尾行）`)
console.log(pass && body.matches.length >= expected.length ? '=== PASS ===' : '=== 檢查差異 ===')
