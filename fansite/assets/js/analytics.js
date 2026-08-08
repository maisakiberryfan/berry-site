/**
 * Analytics 頁模組（由 tool.js 在載入 pages/analytics.htm 時 dynamic import）
 *
 * ── 這一版換掉了什麼 ────────────────────────────────────────────────────
 * 舊版：DuckDB-WASM（jsDelivr CDN，~20MB）＋ sqldata.m-b.win 的每日 parquet 快照
 *       ＋ AI「SQL 小幫手」（/api/text-to-sql，Claude Haiku）。
 * 新版：
 *   1. 統計面板：純 JS 聚合瀏覽器裡「已經有」的表格快取（tool.js 的 IndexedDB），
 *      毫秒級、零引擎下載，開頁第一屏就看得到數字。
 *   2. 選取式查詢建構器：欄位／條件／分組全部用選的，值一律 bind ⇒ 不必會 SQL，
 *      也不必請 AI 代寫（AI 端點連同預算控制一併退役）。
 *   3. 進階 SQL：引擎換成 self-host 的 sql.js（SQLite/WASM，~0.64MB，按下執行才載）。
 * 結果：外部依賴 cdn.jsdelivr.net 與 sqldata.m-b.win 全部消失（CSP 兩側同步收斂），
 *       資料也從「每日快照」變成與表格頁同一份、背景校正過的最新值。
 *
 * v2 既有資產保留：收藏查詢（localStorage）、時間範圍插入工具、XLSX 匯出、
 * Tabulator 結果表格。
 */

import { escapeHtml } from '../../config.js'
import { buildDataset, indexSongs, indexStreams } from './analytics/dataset.js'
import { exampleQueries, COLUMN_REFERENCE, TABLE_NAME } from './analytics/queries.js'
import {
  FIELDS,
  AGGREGATES,
  NUMERIC_FIELDS,
  QUICK_TEMPLATES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildQuery,
  defaultState,
  emptyFilter,
  fieldKind,
  operatorsFor,
  operatorArity,
  coerceOperator,
  aggAlias
} from './analytics/builder.js'
import { runQuery } from './analytics/engine.js'
import {
  mountChart,
  barChartSVG,
  columnChartSVG,
  lineChartSVG,
  formatNumber
} from './analytics/charts.js'
import { MESSAGES, getLang, pick } from './analytics/i18n.js'

const SAVED_QUERIES_KEY = 'berry_analytics_queries'
const TREND_MONTHS = 24

/* ========================= 模組狀態 ========================= */

let lang = 'zh'
let m = MESSAGES.zh
let L = (obj) => pick(obj, 'zh')

let tables = null          // { setlist, songlist, streamlist }
let dataset = []           // 寬表（sql.js 建表用）
let builder = null         // 建構器狀態
let filterUid = 0
let mode = 'builder'
let resultsTable = null
let running = false
let redrawCharts = () => {}

const $id = (id) => document.getElementById(id)

/* ========================= 進入點 ========================= */

export async function initAnalytics() {
  lang = getLang()
  m = MESSAGES[lang] ?? MESSAGES.zh
  L = (obj) => pick(obj, lang)

  // 每次進頁重置（語言切換時 tool.js 會重跑 setContent → 本函式再跑一次）
  builder = withIds(defaultState())
  mode = 'builder'
  resultsTable = null
  running = false

  initStaticText()
  setupEventListeners()
  renderBuilder()
  renderColumnReference()
  renderExamples()
  renderSavedQueries()
  initTimezoneDisplay()

  try {
    // 先以快取秒開，背景校正完成且真有變更時再重畫（SWR，同表格頁行為）。
    // dataset 陣列 identity 一換，engine.js 下次執行查詢就會自動重建 SQLite 表。
    tables = await window.loadBerryTables(applyTables)
    applyTables(tables)
  } catch (err) {
    console.error('[Analytics] 資料載入失敗:', err)
    const box = $id('statsError')
    box.textContent = `${m.loadFailed}：${String(err?.message ?? err)}`
    box.classList.remove('d-none')
    $id('datasetInfo').textContent = m.loadFailed
  }
}

/** 套用一組表格資料：重建寬表、更新筆數、重畫統計 */
function applyTables(next) {
  // 背景校正可能在使用者換頁之後才回來——節點不在就別動（SPA 已換掉 #content）
  if (!next || !$id('statCards')) return
  tables = next
  dataset = buildDataset(
    tables.setlist,
    indexStreams(tables.streamlist),
    indexSongs(tables.songlist)
  )
  $id('datasetInfo').textContent = m.dataInfo(dataset.length)
  renderStats()
}

/* ========================= 靜態文字（i18n 字典） ========================= */

function initStaticText() {
  $id('topSongsTitle').textContent = m.top.title
  $id('topSongsCaption').textContent = m.top.caption
  $id('trendTitle').textContent = m.trend.title
  $id('trendCaption').textContent = m.trend.caption
  $id('trendStreamsLabel').textContent = m.trend.streams
  $id('trendSongsLabel').textContent = m.trend.songs
  $id('topArtistsTitle').textContent = m.artist.title
  $id('topArtistsCaption').textContent = m.artist.caption
  $id('builderIntro').textContent = m.intro
  $id('sqlPreviewLabel').textContent = m.sqlPreview
  $id('btnToAdvanced').textContent = m.copyToAdvanced
  $id('columnReferenceHint').textContent = m.columnsHint ?? ''
  $id('emptyStateText').textContent = m.idle
  $id('errorTitle').textContent = m.errorTitle
}

/* ========================= 統計面板 ========================= */

/** 分類欄位是多值陣列；只要有一項含「歌枠」就算歌枠場 */
function hasKaraoke(categories) {
  if (Array.isArray(categories)) {
    return categories.some(c => typeof c === 'string' && c.includes('歌枠'))
  }
  return typeof categories === 'string' && categories.includes('歌枠')
}

/** time（ISO UTC 字串）→ 'YYYY-MM'；不留檔場（time 為 null）不計入趨勢 */
function monthKeyOf(time) {
  return typeof time === 'string' && time.length >= 7 ? time.slice(0, 7) : null
}

function monthsEndingAt(end, count) {
  const [y, mo] = end.split('-').map(Number)
  const out = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, mo - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

function renderStats() {
  const isEn = lang === 'en'
  const setlist = tables.setlist
  const songlist = tables.songlist
  const streamlist = tables.streamlist

  /* ---- 統計卡 ----
     口徑：總歌曲數＝songlist 列數；總演唱次數＝setlist 列數（同曲唱 N 次算 N 次）；
     總場次數＝streamlist 列數（直播＋投稿影片）；歌枠場數＝categories 含「歌枠」者 */
  const cards = [
    { label: m.stat.songs, value: songlist.length, hint: m.stat.songsHint },
    { label: m.stat.performances, value: setlist.length, hint: '' },
    { label: m.stat.streams, value: streamlist.length, hint: m.stat.streamsHint },
    { label: m.stat.karaoke, value: streamlist.filter(s => hasKaraoke(s.categories)).length, hint: '' }
  ]
  $id('statCards').innerHTML = cards.map(c => `
    <div class="col-6 col-lg-3">
      <div class="border rounded p-3 bg-body-tertiary h-100">
        <div class="small fw-semibold text-body-secondary">${escapeHtml(c.label)}</div>
        <div class="fs-3 fw-semibold" style="font-variant-numeric:tabular-nums">${formatNumber(c.value)}</div>
        ${c.hint ? `<div class="small text-muted">${escapeHtml(c.hint)}</div>` : ''}
      </div>
    </div>`).join('')

  /* ---- Top 20 曲 ---- */
  const songIndex = indexSongs(songlist)
  const songCounts = new Map()
  for (const r of setlist) {
    if (r.songID == null) continue
    const e = songCounts.get(r.songID)
    if (e) e.value += 1
    else songCounts.set(r.songID, { id: r.songID, value: 1, row: r })
  }
  const topSongs = [...songCounts.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, 20)
    .map(e => {
      // songlist 是曲名的正本；setlist 的欄位當 fallback（曲被刪時仍能顯示）
      const s = songIndex.get(e.id) ?? e.row
      const label = isEn
        ? s.songNameEn || s.songName || `#${e.id}`
        : s.songName || s.songNameEn || `#${e.id}`
      const artist = (isEn ? s.artistEn || s.artist : s.artist || s.artistEn) || ''
      return { label, value: e.value, hint: artist }
    })

  /* ---- Top 10 歌手 ---- */
  const artistCounts = new Map()
  for (const r of setlist) {
    const key = String(r.artist ?? '').trim()
    if (!key) continue
    const e = artistCounts.get(key)
    if (e) {
      e.value += 1
      if (!e.en && r.artistEn) e.en = r.artistEn
    } else {
      artistCounts.set(key, { value: 1, ja: key, en: String(r.artistEn ?? '').trim() })
    }
  }
  const topArtists = [...artistCounts.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
    .map(e => ({ label: isEn ? e.en || e.ja : e.ja, value: e.value }))

  /* ---- 月度趨勢 ---- */
  const streamsBy = new Map()
  const songsBy = new Map()
  let latest = null
  const bump = (map, key) => {
    map.set(key, (map.get(key) ?? 0) + 1)
    if (!latest || key > latest) latest = key
  }
  for (const s of streamlist) {
    const key = monthKeyOf(s.time)
    if (key) bump(streamsBy, key)
  }
  for (const r of setlist) {
    const key = monthKeyOf(r.time)
    if (key) bump(songsBy, key)
  }
  const keys = latest ? monthsEndingAt(latest, TREND_MONTHS) : []
  const monthly = {
    keys,
    labels: keys.map(k => `${k.slice(2, 4)}/${k.slice(5, 7)}`),
    streams: keys.map(k => streamsBy.get(k) ?? 0),
    songs: keys.map(k => songsBy.get(k) ?? 0)
  }

  /* ---- 掛載圖表 ---- */
  const empty = `<p class="py-4 text-center text-muted small mb-0">${escapeHtml(m.noData)}</p>`

  redrawCharts = () => {
    if (topSongs.length) {
      mountChart($id('chartTopSongs'), w => barChartSVG({
        items: topSongs, width: w, color: 'var(--berry-primary)',
        valueSuffix: m.unit.times, ariaLabel: m.top.title
      }))
    } else $id('chartTopSongs').innerHTML = empty

    if (monthly.keys.length) {
      mountChart($id('chartStreams'), w => columnChartSVG({
        points: monthly.labels.map((label, i) => ({ label, full: monthly.keys[i], value: monthly.streams[i] })),
        width: w, color: 'var(--berry-pink)',
        valueSuffix: m.unit.streams, ariaLabel: m.trend.streams
      }))
      mountChart($id('chartSongs'), w => lineChartSVG({
        labels: monthly.labels, fullLabels: monthly.keys,
        series: [{ color: 'var(--berry-primary)', values: monthly.songs }],
        width: w, valueSuffix: m.unit.times, ariaLabel: m.trend.songs
      }))
    } else {
      $id('chartStreams').innerHTML = empty
      $id('chartSongs').innerHTML = ''
    }

    if (topArtists.length) {
      mountChart($id('chartArtists'), w => barChartSVG({
        items: topArtists, width: w, color: 'var(--berry-pink)',
        valueSuffix: m.unit.times, maxLabelWidth: 190, ariaLabel: m.artist.title
      }))
    } else $id('chartArtists').innerHTML = empty
  }
  redrawCharts()
}

/* ========================= 建構器 UI ========================= */

/** 每條篩選給一個穩定 id，重繪時才對得上 */
function withIds(state) {
  return { ...state, filters: state.filters.map(f => ({ ...f, _id: ++filterUid })) }
}

const COL_MAP = new Map(COLUMN_REFERENCE.map(c => [c.name, c]))
function fieldLabel(key) {
  const c = COL_MAP.get(key)
  return c ? L(c.short ?? c.desc) : key
}

function opLabel(field, op) {
  const dict = fieldKind(field) === 'date' ? m.opDate : m.op
  return dict[op] ?? m.op[op] ?? op
}

function inputType(field) {
  const kind = fieldKind(field)
  return kind === 'date' ? 'date' : kind === 'number' ? 'number' : 'text'
}

function optionsHTML(items, selected) {
  return items.map(o =>
    `<option value="${escapeHtml(o.value)}"${o.value === selected ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
  ).join('')
}

const FIELD_OPTIONS = () => FIELDS.map(f => ({ value: f.key, label: fieldLabel(f.key) }))

function renderBuilder() {
  renderQuickTemplates()
  renderColumns()
  renderFilters()
  renderGroup()
  renderSort()
  renderPreview()
}

function renderQuickTemplates() {
  const el = $id('quickTemplates')
  el.innerHTML = `<span class="text-muted small">${escapeHtml(m.quick)}</span>` +
    QUICK_TEMPLATES.map(tpl =>
      `<button type="button" class="btn btn-sm btn-outline-secondary rounded-pill" data-tpl="${escapeHtml(tpl.id)}">${escapeHtml(L(tpl.label))}</button>`
    ).join('')
  el.querySelectorAll('[data-tpl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tpl = QUICK_TEMPLATES.find(t => t.id === btn.dataset.tpl)
      if (!tpl) return
      builder = withIds(tpl.state())
      setMode('builder')
      renderBuilder()
    })
  })
}

function renderColumns() {
  const el = $id('builderColumns')
  if (builder.group.enabled) {
    // 分組時具體列出實際輸出欄位（抽象說明不易懂）
    const aggPart = m.aggLabel[builder.group.agg] +
      (builder.group.agg !== 'count' && builder.group.aggField ? `（${fieldLabel(builder.group.aggField)}）` : '')
    el.innerHTML = `
      <div class="fw-medium small mb-2">${escapeHtml(m.columns)}</div>
      <p class="small mb-0">${escapeHtml(m.columnsGroupHint)}：
        <span class="fw-medium">${escapeHtml(fieldLabel(builder.group.field))}</span>
        <span class="text-muted mx-1">＋</span>
        <span class="fw-medium">${escapeHtml(aggPart)}</span>
      </p>`
    return
  }

  el.innerHTML = `
    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
      <span class="fw-medium small">${escapeHtml(m.columns)}</span>
      <div class="d-flex gap-2">
        <button type="button" class="btn btn-sm btn-outline-secondary" id="btnColsAll">${escapeHtml(m.columnsAll)}</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" id="btnColsNone">${escapeHtml(m.columnsNone)}</button>
      </div>
    </div>
    <div class="row row-cols-2 row-cols-sm-3 row-cols-lg-4 g-1">
      ${FIELDS.map(f => `
        <div class="col">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="col_${escapeHtml(f.key)}" data-col="${escapeHtml(f.key)}"${builder.columns.includes(f.key) ? ' checked' : ''}>
            <label class="form-check-label small text-truncate d-block" for="col_${escapeHtml(f.key)}" title="${escapeHtml(f.key)}">${escapeHtml(fieldLabel(f.key))}</label>
          </div>
        </div>`).join('')}
    </div>
    <p class="small text-muted mt-2 mb-0${builder.columns.length ? ' d-none' : ''}" id="colsEmptyHint">${escapeHtml(m.columnsEmpty)}</p>`

  el.querySelectorAll('[data-col]').forEach(box => {
    box.addEventListener('change', () => {
      const key = box.dataset.col
      const i = builder.columns.indexOf(key)
      if (box.checked && i < 0) builder.columns.push(key)
      else if (!box.checked && i >= 0) builder.columns.splice(i, 1)
      $id('colsEmptyHint').classList.toggle('d-none', builder.columns.length > 0)
      renderPreview()
    })
  })
  $id('btnColsAll').addEventListener('click', () => {
    builder.columns = FIELDS.map(f => f.key)
    renderColumns()
    renderPreview()
  })
  $id('btnColsNone').addEventListener('click', () => {
    builder.columns = []
    renderColumns()
    renderPreview()
  })
}

function renderFilters(focusId = null) {
  const el = $id('builderFilters')
  const built = buildQuery(builder)

  const rows = builder.filters.map((f, i) => {
    const arity = operatorArity(f.op)
    const type = inputType(f.field)
    const ops = operatorsFor(fieldKind(f.field) ?? 'text').map(o => ({ value: o.id, label: opLabel(f.field, o.id) }))
    let valueCell = '<div></div>'
    if (arity === 1) {
      valueCell = `<input type="${type}" class="form-control form-control-sm" data-fv="${i}" placeholder="${escapeHtml(m.valuePlaceholder)}" value="${escapeHtml(f.value ?? '')}">`
    } else if (arity === 2) {
      valueCell = `<div class="d-flex align-items-center gap-2">
        <input type="${type}" class="form-control form-control-sm" data-fv="${i}" placeholder="${escapeHtml(m.valuePlaceholder)}" value="${escapeHtml(f.value ?? '')}">
        <span class="text-muted small">${escapeHtml(m.valueTo)}</span>
        <input type="${type}" class="form-control form-control-sm" data-fv2="${i}" placeholder="${escapeHtml(m.valuePlaceholder)}" value="${escapeHtml(f.value2 ?? '')}">
      </div>`
    }
    return `
      <div class="row g-2 align-items-center mb-2">
        <div class="col-6 col-md-3">
          <select class="form-select form-select-sm" id="ff_${i}" data-ff="${i}" aria-label="${escapeHtml(m.filters)}">${optionsHTML(FIELD_OPTIONS(), f.field)}</select>
        </div>
        <div class="col-6 col-md-3">
          <select class="form-select form-select-sm" id="fo_${i}" data-fo="${i}" aria-label="${escapeHtml(m.filters)}">${optionsHTML(ops, f.op)}</select>
        </div>
        <div class="col-10 col-md-5">${valueCell}</div>
        <div class="col-2 col-md-1 text-end">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-fdel="${i}" title="${escapeHtml(m.removeFilter)}" aria-label="${escapeHtml(m.removeFilter)}">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>`
  }).join('')

  el.innerHTML = `
    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
      <span class="fw-medium small">${escapeHtml(m.filters)}</span>
      <span class="text-muted small">${escapeHtml(m.filtersHint)}</span>
    </div>
    ${builder.filters.length ? rows : `<p class="text-muted small mb-2">${escapeHtml(m.noFilters)}</p>`}
    <div class="d-flex flex-wrap align-items-center gap-3">
      <button type="button" class="btn btn-sm btn-outline-secondary" id="btnAddFilter">＋ ${escapeHtml(m.addFilter)}</button>
      ${built.skipped.length ? `<span class="small text-warning-emphasis">${escapeHtml(m.skipped(built.skipped.length))}</span>` : ''}
    </div>`

  el.querySelectorAll('[data-ff]').forEach(sel => {
    sel.addEventListener('change', () => {
      const i = Number(sel.dataset.ff)
      const f = builder.filters[i]
      f.field = sel.value
      // 換欄位可能讓原運算子失效（例如文字→數字），順手校正並清值
      f.op = coerceOperator(f.op, fieldKind(sel.value) ?? 'text')
      f.value = ''
      f.value2 = ''
      renderFilters(`ff_${i}`)
      renderPreview()
    })
  })
  el.querySelectorAll('[data-fo]').forEach(sel => {
    sel.addEventListener('change', () => {
      const i = Number(sel.dataset.fo)
      const f = builder.filters[i]
      f.op = sel.value
      if (operatorArity(sel.value) === 0) {
        f.value = ''
        f.value2 = ''
      }
      renderFilters(`fo_${i}`)
      renderPreview()
    })
  })
  // 值輸入不重繪（重繪會奪走焦點），只更新狀態與 SQL 預覽
  el.querySelectorAll('[data-fv]').forEach(inp => {
    inp.addEventListener('input', () => {
      builder.filters[Number(inp.dataset.fv)].value = inp.value
      renderPreview()
    })
  })
  el.querySelectorAll('[data-fv2]').forEach(inp => {
    inp.addEventListener('input', () => {
      builder.filters[Number(inp.dataset.fv2)].value2 = inp.value
      renderPreview()
    })
  })
  el.querySelectorAll('[data-fdel]').forEach(btn => {
    btn.addEventListener('click', () => {
      builder.filters.splice(Number(btn.dataset.fdel), 1)
      renderFilters()
      renderPreview()
    })
  })
  $id('btnAddFilter').addEventListener('click', () => {
    builder.filters.push({ ...emptyFilter('songName'), _id: ++filterUid })
    renderFilters(`ff_${builder.filters.length - 1}`)
    renderPreview()
  })

  if (focusId) $id(focusId)?.focus()
}

function renderGroup() {
  const el = $id('builderGroup')
  const g = builder.group
  const spec = AGGREGATES.find(a => a.id === g.agg) ?? AGGREGATES[0]
  const aggFieldOptions = (spec.numericOnly ? FIELDS.filter(f => f.kind === 'number') : FIELDS)
    .map(f => ({ value: f.key, label: fieldLabel(f.key) }))

  el.innerHTML = `
    <div class="form-check">
      <input class="form-check-input" type="checkbox" id="groupEnabled"${g.enabled ? ' checked' : ''}>
      <label class="form-check-label fw-medium small" for="groupEnabled">${escapeHtml(m.group)}</label>
    </div>
    ${g.enabled ? `
    <div class="row g-2 mt-1">
      <div class="col-12 col-sm-4">
        <label class="form-label small text-muted mb-1" for="groupField">${escapeHtml(m.groupField)}</label>
        <select class="form-select form-select-sm" id="groupField">${optionsHTML(FIELD_OPTIONS(), g.field)}</select>
      </div>
      <div class="col-12 col-sm-4">
        <label class="form-label small text-muted mb-1" for="groupAgg">${escapeHtml(m.agg)}</label>
        <select class="form-select form-select-sm" id="groupAgg">${optionsHTML(AGGREGATES.map(a => ({ value: a.id, label: m.aggLabel[a.id] })), g.agg)}</select>
      </div>
      ${spec.needsField ? `
      <div class="col-12 col-sm-4">
        <label class="form-label small text-muted mb-1" for="groupAggField">${escapeHtml(m.aggField)}</label>
        <select class="form-select form-select-sm" id="groupAggField">${optionsHTML(aggFieldOptions, g.aggField)}</select>
      </div>` : ''}
    </div>` : ''}`

  $id('groupEnabled').addEventListener('change', e => {
    g.enabled = e.currentTarget.checked
    // 分組後預設看統計值排序；關掉時退回時間排序
    builder.sort = g.enabled
      ? { field: aggAlias(g), dir: 'desc' }
      : { field: 'time', dir: 'desc' }
    renderGroup()
    renderColumns()
    renderSort()
    renderPreview()
  })
  if (!g.enabled) return

  $id('groupField').addEventListener('change', e => {
    const next = e.currentTarget.value
    // 原本照分組欄排序的話跟著換，免得排序下拉指到不存在的選項
    if (builder.sort.field === g.field) builder.sort.field = next
    g.field = next
    renderColumns()
    renderSort()
    renderPreview()
  })
  $id('groupAgg').addEventListener('change', e => {
    g.agg = e.currentTarget.value
    const next = AGGREGATES.find(a => a.id === g.agg)
    if (next?.numericOnly && !NUMERIC_FIELDS.includes(g.aggField)) g.aggField = 'durationSec'
    builder.sort = { field: aggAlias(g), dir: builder.sort.dir }
    renderGroup()
    renderColumns()
    renderSort()
    renderPreview()
  })
  $id('groupAggField')?.addEventListener('change', e => {
    g.aggField = e.currentTarget.value
    renderColumns()
    renderPreview()
  })
}

function renderSort() {
  const el = $id('builderSort')
  const g = builder.group
  const opts = g.enabled
    ? [
        { value: g.field, label: fieldLabel(g.field) },
        { value: aggAlias(g), label: m.aggLabel[g.agg] }
      ]
    : [{ value: '', label: m.sortNone }, ...FIELD_OPTIONS()]

  el.innerHTML = `
    <span class="fw-medium small d-block mb-2">${escapeHtml(m.sort)}</span>
    <div class="row g-2">
      <div class="col-12 col-sm-4">
        <select class="form-select form-select-sm" id="sortField" aria-label="${escapeHtml(m.sort)}">${optionsHTML(opts, builder.sort.field)}</select>
      </div>
      <div class="col-12 col-sm-4">
        <select class="form-select form-select-sm" id="sortDir" aria-label="${escapeHtml(m.sort)}">
          ${optionsHTML([{ value: 'desc', label: m.dirDesc }, { value: 'asc', label: m.dirAsc }], builder.sort.dir)}
        </select>
      </div>
      <div class="col-12 col-sm-4 d-flex align-items-center gap-2">
        <label class="form-label small text-muted mb-0 text-nowrap" for="limitInput">${escapeHtml(m.limit)}</label>
        <input type="number" min="1" max="${MAX_LIMIT}" class="form-control form-control-sm" id="limitInput" value="${escapeHtml(builder.limit)}">
      </div>
    </div>`

  $id('sortField').addEventListener('change', e => {
    builder.sort.field = e.currentTarget.value
    renderPreview()
  })
  $id('sortDir').addEventListener('change', e => {
    builder.sort.dir = e.currentTarget.value
    renderPreview()
  })
  $id('limitInput').addEventListener('input', e => {
    builder.limit = e.currentTarget.value || DEFAULT_LIMIT
    renderPreview()
  })
}

function renderPreview() {
  $id('sqlPreview').textContent = buildQuery(builder).preview
}

/* ========================= 進階模式輔助 UI ========================= */

function renderColumnReference() {
  const el = $id('columnReferenceList')
  el.innerHTML = COLUMN_REFERENCE.map(col => `
    <li class="col-12 col-md-6 small mb-1">
      <button type="button" class="btn btn-link p-0 font-monospace align-baseline" data-colref="${escapeHtml(col.name)}">${escapeHtml(col.name)}</button>
      <span class="text-muted"> — ${escapeHtml(L(col.desc))} (${escapeHtml(col.type)})</span>
      ${col.example ? `<br><small class="text-muted font-monospace ms-3">${escapeHtml(col.example)}</small>` : ''}
    </li>`).join('')
  el.querySelectorAll('[data-colref]').forEach(btn => {
    btn.addEventListener('click', () => insertAtCursor($id('sqlEditor'), btn.dataset.colref))
  })
}

function renderExamples() {
  const el = $id('exampleQueries')
  const list = exampleQueries()
  el.innerHTML = list.map(ex =>
    `<button type="button" class="btn btn-sm btn-outline-info" data-ex="${escapeHtml(ex.id)}">${escapeHtml(L(ex.label))}</button>`
  ).join('')
  el.querySelectorAll('[data-ex]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ex = list.find(e => e.id === btn.dataset.ex)
      if (!ex) return
      setMode('advanced')
      $id('sqlEditor').value = ex.sql
      $id('sqlEditor').focus()
    })
  })
}

/* ========================= 事件綁定 ========================= */

function setMode(next) {
  mode = next
  const builderOn = next === 'builder'
  $id('builderPanel').style.display = builderOn ? 'block' : 'none'
  $id('advancedPanel').style.display = builderOn ? 'none' : 'block'
  $id('modeBuilder').checked = builderOn
  $id('modeAdvanced').checked = !builderOn
  if (!builderOn && !$id('sqlEditor').value.trim()) {
    $id('sqlEditor').value = buildQuery(builder).preview
  }
}

function setupEventListeners() {
  $id('modeBuilder').addEventListener('change', () => setMode('builder'))
  $id('modeAdvanced').addEventListener('change', () => setMode('advanced'))

  $id('btnToAdvanced').addEventListener('click', () => {
    // 建構器 → 進階模式：帶值內嵌的版本，貼過去可以直接改直接跑
    $id('sqlEditor').value = buildQuery(builder).preview
    setMode('advanced')
    $id('sqlEditor').focus()
  })

  $id('btnRunBuilder').addEventListener('click', () => {
    const built = buildQuery(builder)
    execute(built.sql, built.params)
  })
  $id('btnRunSQL').addEventListener('click', () => execute($id('sqlEditor').value))

  $id('btnExportXLSX').addEventListener('click', handleExportXLSX)
  $id('btnSaveQuery').addEventListener('click', handleSaveQuery)

  $id('startDateInput').addEventListener('input', handleDateRangeChange)
  $id('endDateInput').addEventListener('input', handleDateRangeChange)
  $id('btnInsertRange').addEventListener('click', () => {
    const cond = $id('rangeOutput').value
    if (cond) insertAtCursor($id('sqlEditor'), cond)
  })

  // 切回統計籤時重畫圖表（隱藏中的分頁 clientWidth 為 0，畫不出來）
  $id('tabStatsBtn').addEventListener('shown.bs.tab', () => redrawCharts())

  // Bootstrap tooltip（ES module 作用域需用 window.bootstrap）
  document.querySelectorAll('#analyticsPage [data-bs-toggle="tooltip"]').forEach(el => {
    new window.bootstrap.Tooltip(el, { container: 'body' })
  })
}

/* ========================= 查詢執行 ========================= */

async function execute(sql, params = null) {
  const text = String(sql ?? '').trim()
  if (!text || running) return { ok: false }
  running = true
  showError(null)
  $id('emptyState').style.display = 'none'
  showLoading(m.stage.query)

  try {
    const result = await runQuery(text, dataset, stage => showLoading(m.stage[stage] ?? m.stage.query), params)
    await displayResults(result)
    return { ok: true }
  } catch (err) {
    console.error('[Analytics] 查詢失敗:', err)
    if (resultsTable) {
      resultsTable.destroy()
      resultsTable = null
    }
    $id('resultInfo').style.display = 'none'
    $id('btnExportXLSX').disabled = true
    showError(String(err?.message ?? err))
    return { ok: false, error: String(err?.message ?? err) }
  } finally {
    running = false
    showLoading(null)
  }
}

async function displayResults(result) {
  await window.loadTabulator()

  if (resultsTable) {
    resultsTable.destroy()
    resultsTable = null
  }

  $id('resultInfo').textContent = m.resultInfo(result.rows.length, result.ms)
  $id('resultInfo').style.display = 'block'
  $id('btnExportXLSX').disabled = result.rows.length === 0

  if (!result.rows.length) {
    $id('emptyState').style.display = 'block'
    $id('emptyStateText').textContent = m.empty
    return
  }
  $id('emptyState').style.display = 'none'

  const columns = result.columns.map(c => ({
    title: c.key,
    field: c.key,
    sorter: c.numeric ? 'number' : 'string',
    hozAlign: c.numeric ? 'right' : 'left'
  }))

  resultsTable = new window.Tabulator($id('resultsTable'), {
    data: result.rows,
    columns,
    layout: 'fitData',
    pagination: true,
    paginationSize: 50,
    paginationSizeSelector: [20, 50, 100, 200],
    movableColumns: true,
    resizableColumns: true,
    initialSort: []   // 不預設排序，尊重 SQL 的 ORDER BY
  })
}

/* ========================= 匯出 ========================= */

async function handleExportXLSX() {
  if (!resultsTable) return
  try {
    // CSP 前置：xlsx vendor script 由 tool.js 的 window.loadXLSX() 以原生 <script src> 載入
    await window.loadXLSX()
    const data = resultsTable.getData()
    if (!data.length) {
      showMessage(m.exportEmpty, 'warning')
      return
    }
    const ws = window.XLSX.utils.json_to_sheet(data)
    const wb = window.XLSX.utils.book_new()
    window.XLSX.utils.book_append_sheet(wb, ws, 'Query Results')
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
    const filename = `berry-analytics-${stamp}.xlsx`
    window.XLSX.writeFile(wb, filename)
    showMessage(m.exportOk(filename), 'success')
  } catch (error) {
    console.error('[Analytics] XLSX 匯出失敗:', error)
    showMessage(`${m.exportFail}：${error.message}`, 'error')
  }
}

/* ========================= 收藏查詢（localStorage） ========================= */

function getSavedQueries() {
  try {
    const saved = localStorage.getItem(SAVED_QUERIES_KEY)
    return saved ? JSON.parse(saved) : []
  } catch (error) {
    console.error('[Analytics] 讀取收藏查詢失敗:', error)
    return []
  }
}

function writeSavedQueries(list) {
  try {
    localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(list))
  } catch (error) {
    console.error('[Analytics] 寫入收藏查詢失敗:', error)
  }
}

function handleSaveQuery() {
  const entry = {
    id: Date.now(),
    mode,
    createdAt: new Date().toISOString()
  }

  if (mode === 'builder') {
    // 存整份建構器狀態（不含 _id，那是重繪用的臨時鍵）
    entry.builder = {
      columns: [...builder.columns],
      filters: builder.filters.map(({ _id, ...rest }) => rest),
      group: { ...builder.group },
      sort: { ...builder.sort },
      limit: builder.limit
    }
    const g = builder.group
    entry.defaultName = g.enabled
      ? `${fieldLabel(g.field)} · ${m.aggLabel[g.agg]}`
      : (builder.columns.length ? builder.columns.join(', ') : TABLE_NAME)
  } else {
    const sql = $id('sqlEditor').value.trim()
    if (!sql) {
      showMessage(m.saveEmpty, 'warning')
      return
    }
    entry.sql = sql
    entry.defaultName = sql.slice(0, 50) + (sql.length > 50 ? '…' : '')
  }

  const name = prompt(m.saveNamePrompt, entry.defaultName)
  if (name === null) return
  entry.name = name.trim() || entry.defaultName

  const list = getSavedQueries()
  list.push(entry)
  writeSavedQueries(list)
  renderSavedQueries()
  showMessage(m.saveOk(entry.name), 'success')
}

/**
 * 舊版（DuckDB 時代）的 simple 模式收藏：queryType 指向已移除的 QUERY_DEFINITIONS。
 * 對應到建構器的快速範本，讓舊收藏不至於變成死項目。
 */
const LEGACY_TEMPLATE = { 'song-frequency': 'song-frequency', 'top-songs': 'top-songs' }

function renderSavedQueries() {
  const panel = $id('savedQueriesPanel')
  const list = getSavedQueries()
  if (!list.length) {
    panel.style.display = 'none'
    return
  }
  panel.style.display = 'block'

  $id('savedQueriesList').innerHTML = list.map((q, i) => {
    const legacy = q.mode === 'simple'
    const icon = q.sql ? 'bi-code-slash' : 'bi-ui-checks'
    const when = new Date(q.createdAt).toLocaleString(lang === 'ja' ? 'ja-JP' : lang === 'en' ? 'en-US' : 'zh-TW', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    })
    return `
      <div class="list-group-item">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div class="flex-grow-1 overflow-hidden">
            <h6 class="mb-1 text-truncate"><i class="bi ${icon} me-2"></i>${escapeHtml(q.name ?? q.defaultName ?? '')}</h6>
            <small class="text-muted">${escapeHtml(when)}${legacy ? ` ${escapeHtml(m.savedLegacy)}` : ''}</small>
          </div>
          <div class="btn-group flex-shrink-0">
            <button class="btn btn-sm btn-outline-primary" data-load="${i}" title="load"><i class="bi bi-play-circle"></i></button>
            <button class="btn btn-sm btn-outline-danger" data-del="${i}" title="delete"><i class="bi bi-trash"></i></button>
          </div>
        </div>
      </div>`
  }).join('')

  $id('savedQueriesList').querySelectorAll('[data-load]').forEach(btn => {
    btn.addEventListener('click', () => loadSavedQuery(Number(btn.dataset.load)))
  })
  $id('savedQueriesList').querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteSavedQuery(Number(btn.dataset.del)))
  })
}

function loadSavedQuery(index) {
  const q = getSavedQueries()[index]
  if (!q) return

  if (q.sql) {
    setMode('advanced')
    $id('sqlEditor').value = q.sql
    showMessage(m.loadOk(q.name ?? ''), 'info')
    execute(q.sql)
    return
  }

  if (q.builder) {
    builder = withIds(q.builder)
  } else {
    // 舊版 simple 模式：對應到最接近的快速範本
    const tplId = LEGACY_TEMPLATE[q.queryType]
    const tpl = QUICK_TEMPLATES.find(t => t.id === tplId) ?? QUICK_TEMPLATES[0]
    builder = withIds(tpl.state())
  }
  setMode('builder')
  renderBuilder()
  showMessage(m.loadOk(q.name ?? ''), 'info')
  const built = buildQuery(builder)
  execute(built.sql, built.params)
}

function deleteSavedQuery(index) {
  const list = getSavedQueries()
  const q = list[index]
  if (!q) return
  if (!confirm(m.deleteConfirm(q.name ?? ''))) return
  list.splice(index, 1)
  writeSavedQueries(list)
  renderSavedQueries()
  showMessage(m.deleteOk(q.name ?? ''), 'success')
}

/* ========================= 時間範圍工具 ========================= */

function initTimezoneDisplay() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const offsetMin = -new Date().getTimezoneOffset()
    const sign = offsetMin >= 0 ? '+' : '-'
    const abs = Math.abs(offsetMin)
    const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    $id('userTimezone').textContent = tz || 'Unknown'
    $id('userTimezoneOffset').textContent = `UTC${offset}`
  } catch (error) {
    console.warn('[Analytics] 時區偵測失敗:', error)
    $id('userTimezone').textContent = 'Unknown'
    $id('userTimezoneOffset').textContent = '—'
  }
}

/** 'YYYY-MM-DDTHH:mm' → berry_data.time 的字串格式 'YYYY-MM-DD HH:mm'（所見即所得，無轉換） */
function handleDateRangeChange() {
  const start = $id('startDateInput').value
  const end = $id('endDateInput').value
  const out = $id('rangeOutput')
  if (!start || !end) {
    out.value = ''
    $id('btnInsertRange').disabled = true
    return
  }
  out.value = `time >= '${start.replace('T', ' ').slice(0, 16)}' AND time < '${end.replace('T', ' ').slice(0, 16)}'`
  $id('btnInsertRange').disabled = false
}

/* ========================= UI 小工具 ========================= */

function insertAtCursor(textarea, text) {
  if (!textarea) return
  const s = textarea.selectionStart ?? textarea.value.length
  const e = textarea.selectionEnd ?? textarea.value.length
  textarea.value = textarea.value.slice(0, s) + text + textarea.value.slice(e)
  const pos = s + text.length
  textarea.setSelectionRange(pos, pos)
  textarea.focus()
}

function showLoading(stageText) {
  const el = $id('loadingIndicator')
  if (!stageText) {
    el.style.display = 'none'
    return
  }
  $id('loadingStage').textContent = stageText
  el.style.display = 'block'
}

function showError(detail) {
  const el = $id('errorMessage')
  if (!detail) {
    el.style.display = 'none'
    return
  }
  $id('errorDetail').textContent = detail
  el.style.display = 'block'
}

/** 通用訊息（success 自動 3 秒收起） */
function showMessage(message, type = 'info') {
  const alert = $id('messageAlert')
  const icon = $id('messageIcon')
  if (!alert || !icon) return
  const map = {
    success: ['bi bi-check-circle-fill', 'alert-success'],
    error: ['bi bi-exclamation-triangle-fill', 'alert-danger'],
    warning: ['bi bi-exclamation-circle-fill', 'alert-warning'],
    info: ['bi bi-info-circle-fill', 'alert-info']
  }
  const [iconClass, alertClass] = map[type] ?? map.info
  alert.className = `alert alert-dismissible fade show ${alertClass}`
  icon.className = `${iconClass} me-2`
  $id('messageText').textContent = message
  alert.style.display = 'block'
  if (type === 'success') {
    setTimeout(() => { alert.style.display = 'none' }, 3000)
  }
}
