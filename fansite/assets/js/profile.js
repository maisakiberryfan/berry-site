// Profile page script — BGM 播放器 + 出道時間計算
// 從 pages/profile.htm 的 inline <script> 外抽（CSP 前置，見批次 E）
// 未進 esbuild bundle，由 tool.js 以 import('/assets/js/profile.js') 動態載入，
// 故沿用 tool.js 掛在 window 上的 jQuery / dayjs，而非各自 import 套件

const $ = window.jQuery
const dayjs = window.dayjs

export function initProfile() {
    const player = document.getElementById('bgmPlayer')

    $('input[name="bgm"]').on('change', ()=>{
        const $checked = $('input[name="bgm"]:checked')
        const val = $checked.val()
        if(!val) return
        player.src = `img/profile/bgm/${val}.mp3`
        player.play().catch(() => {})
        // 顯示播放中曲目與作曲者
        $('#bgmNowName').text(`BGM${val}`)
        $('#bgmNowComposer').text($checked.data('composer') || '')
        $('#bgmNowPlaying').show()
    })

    // 計算出道時間（年月日）
    const debutDate = $('#debutRow').data('debut')
    const debut = dayjs(debutDate)
    const today = dayjs()
    const years = today.diff(debut, 'year')
    const months = today.diff(debut.add(years, 'year'), 'month')
    const days = today.diff(debut.add(years, 'year').add(months, 'month'), 'day')
    const currentLang = localStorage.getItem('lang') || 'zh'
    let durationText
    if (currentLang === 'ja') {
        durationText = `${years}年${months}ヶ月${days}日`
    } else if (currentLang === 'en') {
        durationText = `${years}y ${months}m ${days}d`
    } else {
        durationText = `${years}年${months}個月${days}天`
    }
    $('#debutRow').text(`${debutDate}（${durationText}）`)
}
