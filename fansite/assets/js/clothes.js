// Clothes page script — 衣裝列表 + 詳細 modal + fancybox gallery + hash 直達
// 從 pages/clothes.htm 的 inline <script> 外抽（CSP 前置，見批次 E）
// 未進 esbuild bundle，由 tool.js 以 import('/assets/js/clothes.js') 動態載入，
// 故沿用 tool.js 掛在 window 上的 jQuery / dayjs / bootstrap，而非各自 import 套件

const $ = window.jQuery
const dayjs = window.dayjs
const bootstrap = window.bootstrap

export function initClothes() {
  // tCount = 表情差分張數（官網抓的 tX.webp；官網未更新的衣裝為 0）
  const sourceArray = [
      {"name":"3D-にゃんにゃん衣装","date":"20260611","designer":"ぬこ","modeler":"REI","link":"Gh6AsG8DmCI","count":5, "tCount":0, "sideView":1},
      {"name":"2D-冬服","date":"20260212","designer":"みわうに","modeler":"うなぬん","link":"OraWP0bLPfY","count":4, "tCount":0},
      {"name":"2D-アイドル衣装3","date":"20250526","designer":"みわうに","modeler":"うなぬん","link":"9G0RAa5cOlY","count":5, "tCount":0},
      {"name":"2D-JK服","date":"20250120","designer":"みわうに","modeler":"乃樹坂くしお","link":"s8xse8ghpTw","count":7, "tCount":9},
      {"name":"3D-衣装4","date":"20241205","designer":"ana","modeler":"Rぷりん","link":"tXgcfNdmL84","count":8, "tCount":9, "sideView":2},
      {"name":"2D-和服メイド","date":"20240617","designer":"みわうに","modeler":"乃樹坂くしお","link":"x4_vih6njco","count":6, "tCount":9},
      {"name":"2D-ルームウェア","date":"20240116","designer":"みわうに","modeler":"乃樹坂くしお","link":"_puahGBIXPs","count":8, "tCount":9},
      {"name":"3D-衣装3","date":"20230905","designer":"ana","modeler":"Rぷりん","link":"61TdPwpqekc","count":7, "tCount":9, "sideView":2},
      {"name":"2D-新衣装","date":"20230515","designer":"みわうに","modeler":"乃樹坂くしお","link":"LZPbxTodH7M","count":5, "tCount":9},
      {"name":"2D-アイドル衣装2","date":"20220905","designer":"みわうに","modeler":"クワガタ","link":"42suuMXG2Gw","count":5, "tCount":9},
      {"name":"3D-衣装2","date":"20220815","designer":"ana","modeler":"REI","link":"k7dberaRllk","count":6, "tCount":9, "sideView":2},
      {"name":"2D-衣装","date":"20220515","designer":"みわうに","modeler":"わくー。","link":"-UNwTux9VSw","count":6, "tCount":9},
      {"name":"2D-アイドル衣装1","date":"20210910","designer":"みわうに","modeler":"わくー。","link":"mqIXh62KGoo","count":5, "tCount":9},
      {"name":"3D-衣装1","date":"20210724","designer":"ana","modeler":"REI","link":"Tv-B6rqKhMU","count":6, "tCount":9, "sideView":2},
      {"name":"2D-ver1.5","date":"20210213","designer":"ケイ","modeler":"わくー。","link":"RQC8Af2TWHc","count":1, "tCount":0},
      {"name":"2D-初期衣装","date":"20200815","designer":"ケイ","modeler":"わくー。","link":"DkoSEEItb5Y","count":1, "tCount":0}
  ]

  const itemsBaseURL = "img/clothes/"
  const detailModalEl = document.getElementById('clothDetailModal')
  const detailModal = new bootstrap.Modal(detailModalEl)

  //生成預覽（列表僅名稱＋日期，詳細資訊移入 modal——官網式乾淨列表）
  let data = sourceArray.map((e, idx) => {
    const dim = e.name.startsWith('3D') ? '3D' : '2D'
    return `<figure class="figure figure-cloth" data-dim="${dim}" data-idx="${idx}" style="cursor: pointer;">
      <img src="${itemsBaseURL}${e.date}/s1.webp" class="figure-img" width="324" height="576" loading="lazy" alt="${e.name}">
      <figcaption class="figure-caption fs-5">
        <p class="mb-0">${e.name}<br>
        <span class="fs-6">${dayjs(e.date, "YYYYMMDD").format('YYYY/MM/DD')}</span></p>
      </figcaption>
    </figure>`
  })

  $('#pic').html(data.join(''))

  // 2D/3D 篩選（display 切換，不重渲染）
  $('input[name="clothDim"]').on('change', () => {
    const val = $('input[name="clothDim"]:checked').val()
    $('#pic .figure-cloth').each(function () {
      $(this).toggle(val === 'all' || $(this).data('dim') === val)
    })
  })

  const fancyboxOptions = {
    Thumbs: { autoStart: true },
    Toolbar: {
      display: [
        { id: 'counter', position: 'left' },
        'zoom',
        'close'
      ]
    },
    Carousel: { transition: 'fade', infinite: false }
  }

  const galleryItems = (e, prefix, count) => Array.from({ length: count }, (_, i) => ({
    src: `${itemsBaseURL}${e.date}/${prefix}${i + 1}.webp`,
    thumb: `${itemsBaseURL}${e.date}/${prefix}${i + 1}.webp`
  }))

  const openGallery = (e, prefix, count, startIndex = 0) => {
    window.loadFancybox().then(Fancybox => {
      Fancybox.show(galleryItems(e, prefix, count), { startIndex, ...fancyboxOptions })
    })
  }

  let currentOutfit = null

  // 填入 modal 內容（官網式：左大立繪、右表情差分格＋資訊卡）
  function showDetail(idx) {
    // 防禦：離開本頁後殘留的 hashchange listener（back/forward 時機早於新頁 script）
    // 對 detached modal 呼叫 show() 會產生清不掉的孤兒 backdrop
    if (!document.body.contains(detailModalEl)) return
    const e = sourceArray[idx]
    if (!e) return
    currentOutfit = e

    $('#clothDetailTitle').text(e.name)
    $('#clothDetailMain').attr('src', `${itemsBaseURL}${e.date}/s1.webp`).attr('alt', e.name)
    $('#clothDetailDate').text(dayjs(e.date, "YYYYMMDD").format('YYYY/MM/DD'))
    $('#clothDetailDesigner').text(e.designer)
    $('#clothDetailModeler').text(e.modeler)
    $('#clothDetailYT').attr('href', `https://youtu.be/${e.link}`)
    $('#clothDetailSideView').toggle(!!e.sideView)

    // 右側格：只在有表情差分（t 檔）時顯示；沒有就整區隱藏（其他立繪由點擊大立繪的 fancybox 看）
    // （標籤為靜態三語 span，語言切換由 tool.js 全域 shown.bs.modal handler 處理）
    const $faces = $('#clothDetailFaces').empty()
    if (e.tCount > 0) {
      const imgs = Array.from({ length: e.tCount }, (_, i) =>
        `<img src="${itemsBaseURL}${e.date}/t${i + 1}.webp" class="img-fluid rounded" style="cursor: zoom-in;" data-index="${i}" loading="lazy">`
      ).join('')
      $faces.html(imgs)
      $('#clothDetailFacesWrap').show()
    } else {
      $('#clothDetailFacesWrap').hide()
    }

    history.replaceState(null, '', `#${e.date}`)
    detailModal.show()
  }

  // 列表點擊 → 開 modal
  $('#pic').on('click', '.figure-cloth', function () {
    showDetail($(this).data('idx'))
  })

  // modal 內互動：大立繪 → s 系列全圖；差分縮圖 → 對應系列從該張開始；四面圖按鈕 → c 系列
  $('#clothDetailMain').on('click', () => {
    if (currentOutfit) openGallery(currentOutfit, 's', currentOutfit.count, 0)
  })
  $('#clothDetailFaces').on('click', 'img', function () {
    if (!currentOutfit) return
    openGallery(currentOutfit, 't', currentOutfit.tCount, $(this).data('index'))
  })
  $('#clothDetailSideView').on('click', () => {
    if (currentOutfit?.sideView) openGallery(currentOutfit, 'c', currentOutfit.sideView, 0)
  })

  // 關閉 modal 時清掉 hash（避免重整又彈出）
  detailModalEl.addEventListener('hidden.bs.modal', () => {
    if (location.hash) history.replaceState(null, '', location.pathname)
  })

  // Hash 直達：#YYYYMMDD 開 modal；#YYYYMMDD-N 直接開 fancybox 第 N 張；
  // #YYYYMMDD_s（舊版四面圖 gallery 連結）開該套 modal（四面圖入口在資訊卡）
  function handleHashNavigation() {
    const hash = window.location.hash.substring(1)
    if (!hash) return
    const parts = hash.split('-')
    const date = parts[0].replace(/_s$/, '')
    const idx = sourceArray.findIndex(e => e.date === date)
    if (idx === -1) return

    if (parts[1] && !parts[0].endsWith('_s')) {
      const imgIndex = Math.max(0, parseInt(parts[1]) - 1)
      const e = sourceArray[idx]
      // hash 直達的 gallery 關閉時清 hash（否則 F5 又彈出）；modal 路徑由 hidden.bs.modal 清
      window.loadFancybox().then(Fancybox => {
        Fancybox.show(galleryItems(e, 's', e.count), {
          startIndex: Math.min(imgIndex, e.count - 1),
          ...fancyboxOptions,
          on: { close: () => { if (location.hash) history.replaceState(null, '', location.pathname) } }
        })
      })
    } else {
      showDetail(idx)
    }
  }

  handleHashNavigation()
  // SPA 重入本頁時 window 上的舊 listener 還在（閉包綁著已 detach 的舊 modal 節點，
  // 觸發會產生關不掉的孤兒 backdrop）——掛新 listener 前先移除舊的
  if (window._clothesHashHandler) window.removeEventListener('hashchange', window._clothesHashHandler)
  window._clothesHashHandler = handleHashNavigation
  window.addEventListener('hashchange', window._clothesHashHandler)
}
