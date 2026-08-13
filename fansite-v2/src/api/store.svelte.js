// 資料層核心 — 三層瀑布：IndexedDB → CDN 快照 → API 背景增量校正
//
// 對外每張表都是同一組介面（見檔案末尾的 export 摘要）：
//   store.rows / store.loading / store.synced / store.error   ← reactive（$state.raw）
//   store.load()      冪等，首次呼叫啟動瀑布；重複呼叫回同一個 promise
//   store.reload()    強制忽略 ETag 重抓（工具列「重新載入」用）
//   store.applyLocalInsert(row) / applyLocalUpdate(row) / applyLocalDelete(key)
//     ↑ 寫 API 成功後呼叫：更新記憶體 rows ＋ IndexedDB，不重抓
//
// ⚠️ rows 是 $state.raw：一律「整包替換」而非就地 mutate（helper 已處理）。
// ⚠️ 不要解構 store（`const { rows } = songlist` 會失去 reactivity），用 store.rows。

import {
  get as idbGet,
  set as idbSet,
  getMany as idbGetMany,
  setMany as idbSetMany,
  delMany as idbDelMany,
  createStore,
} from 'idb-keyval'
import { apiGet, apiPost, fetchSnapshot } from './client.js'

/* ========================= IndexedDB（可用性降級） ========================= */

// DB / store 名沿用現站（berry-cache / tables），快取與現站互不干擾但慣例一致
let idbStore = null
let idbAvailable = true
let idbWarned = false

try {
  idbStore = createStore('berry-cache', 'tables')
} catch (err) {
  idbAvailable = false
  warnIdbOnce(err)
}

function warnIdbOnce(err) {
  if (idbWarned) return
  idbWarned = true
  console.warn('[cache] IndexedDB 不可用，降級為「快照 + API 直抓」（私密視窗屬正常情況）', err)
}

function markIdbDown(err) {
  idbAvailable = false
  warnIdbOnce(err)
}

// 某些被鎖住的瀏覽器環境 IDB 不 throw 而是永不 resolve——不設限會卡死整條載入瀑布
const IDB_TIMEOUT_MS = 2000

function withIdbTimeout(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`IndexedDB 操作逾時（>${IDB_TIMEOUT_MS}ms），視為不可用`)),
      IDB_TIMEOUT_MS,
    )
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function cacheGet(key) {
  if (!idbAvailable) return undefined
  try {
    return await withIdbTimeout(idbGet(key, idbStore))
  } catch (err) {
    markIdbDown(err)
    return undefined
  }
}

async function cacheGetMany(keys) {
  if (!idbAvailable || keys.length === 0) return keys.map(() => undefined)
  try {
    return await withIdbTimeout(idbGetMany(keys, idbStore))
  } catch (err) {
    markIdbDown(err)
    return keys.map(() => undefined)
  }
}

async function cacheSet(key, value) {
  if (!idbAvailable) return
  try {
    await withIdbTimeout(idbSet(key, value, idbStore))
  } catch (err) {
    markIdbDown(err)
  }
}

async function cacheSetMany(entries) {
  if (!idbAvailable || entries.length === 0) return
  try {
    await withIdbTimeout(idbSetMany(entries, idbStore))
  } catch (err) {
    markIdbDown(err)
  }
}

async function cacheDelMany(keys) {
  if (!idbAvailable || keys.length === 0) return
  try {
    await withIdbTimeout(idbDelMany(keys, idbStore))
  } catch (err) {
    markIdbDown(err)
  }
}

/** 快取秒開時做隔離拷貝，避免 UI 就地編輯污染後續寫回的資料 */
function isolate(value) {
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

/* ========================= 共通小工具 ========================= */

const CACHE_KEY = {
  table: (type) => `table:${type}`,
  setlistMeta: 'setlist:meta',
  setlistMonth: (month) => `setlist:m:${month}`,
  ytLatest: 'ytlatest',
}

function logSync(tag, ...args) {
  console.debug(`[sync] ${tag}`, ...args)
}

/** 併發上限的 map（快照首訪要抓十幾個月份檔） */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

/* ========================= 泛用「單表 + ETag」store ========================= */
/**
 * songlist / streamlist：全量端點有 meta ETag。
 *   IDB →（無則）快照 → 背景 If-None-Match 校正（304 跳過 / 200 整包替換）
 */
function createEtagTable({ type, endpoint, snapshotFile, keyOf, compare }) {
  let rows = $state.raw([])
  let loading = $state(false)
  let synced = $state(false)
  let error = $state(null)

  let etag = null
  let started = false
  let ready = null

  function sortRows(list) {
    return compare ? [...list].sort(compare) : list
  }

  async function persist() {
    await cacheSet(CACHE_KEY.table(type), { data: rows, etag, timestamp: Date.now() })
  }

  async function primeFromCache() {
    const cached = await cacheGet(CACHE_KEY.table(type))
    if (cached && Array.isArray(cached.data) && cached.data.length) {
      rows = isolate(cached.data)
      etag = cached.etag ?? null
      logSync(type, `IDB 命中 ${rows.length} 筆`)
      return true
    }
    return false
  }

  async function primeFromSnapshot() {
    if (!snapshotFile) return false
    const snap = await fetchSnapshot(snapshotFile)
    if (Array.isArray(snap) && snap.length) {
      rows = snap
      etag = null // 靜態快照沒有 ETag，背景校正必然拿 200 整包
      logSync(type, `快照命中 ${rows.length} 筆`)
      await persist()
      return true
    }
    return false
  }

  async function sync({ force = false } = {}) {
    try {
      const res = await apiGet(endpoint, { etag: force ? null : etag })
      if (res.notModified) {
        if (res.etag) etag = res.etag
        logSync(type, '無變更 (304)')
      } else if (Array.isArray(res.data)) {
        rows = res.data
        etag = res.etag ?? null
        logSync(type, `已更新 ${rows.length} 筆`)
        await persist()
      } else {
        // 200 但形狀不對（如 SPA fallback 回 HTML）——保留現有資料，不覆寫快取
        console.warn(`[sync] ${type} 回應非陣列，保留現有資料`, res.data)
      }
      synced = true
      error = null
    } catch (err) {
      error = err
      console.warn(`[sync] ${type} 背景校正失敗`, err)
    } finally {
      loading = false
    }
  }

  function load() {
    if (started) return ready
    started = true
    ready = (async () => {
      loading = true
      const primed = (await primeFromCache()) || (await primeFromSnapshot())
      if (primed) loading = false
      await sync()
    })()
    return ready
  }

  async function reload() {
    started = true
    if (!rows.length) loading = true
    synced = false
    await sync({ force: true })
  }

  return {
    get rows() {
      return rows
    },
    get loading() {
      return loading
    },
    get synced() {
      return synced
    },
    get error() {
      return error
    },
    keyOf,
    load,
    reload,
    /** 寫 API 成功後：本地插入（含排序）＋ 寫回 IDB */
    applyLocalInsert(row) {
      rows = sortRows([...rows, row])
      return persist()
    },
    /** 寫 API 成功後：以主鍵合併更新（patch 語意，未出現的欄位保留） */
    applyLocalUpdate(row) {
      const k = keyOf(row)
      rows = sortRows(rows.map((r) => (keyOf(r) === k ? { ...r, ...row } : r)))
      return persist()
    },
    /** 寫 API 成功後：以主鍵刪除（傳主鍵值或整列皆可） */
    applyLocalDelete(keyOrRow) {
      const k = typeof keyOrRow === 'object' && keyOrRow !== null ? keyOf(keyOrRow) : keyOrRow
      rows = rows.filter((r) => keyOf(r) !== k)
      return persist()
    },
  }
}

/* ========================= songlist / streamlist ========================= */

export const songlist = createEtagTable({
  type: 'songlist',
  endpoint: '/api/songlist',
  snapshotFile: 'songlist.json',
  keyOf: (r) => r.songID,
  compare: (a, b) => (b.songID ?? 0) - (a.songID ?? 0), // ORDER BY songID DESC
})

export const streamlist = createEtagTable({
  type: 'streamlist',
  endpoint: '/api/streamlist',
  snapshotFile: 'streamlist.json',
  keyOf: (r) => r.streamID,
  compare: (a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')), // ORDER BY time DESC
})

/* ========================= aliases（無 ETag、無快照） ========================= */
/** 量小（~90 筆）：IDB 秒開後一律直抓 API 覆蓋 */
function createAliasesStore() {
  let rows = $state.raw([])
  let loading = $state(false)
  let synced = $state(false)
  let error = $state(null)

  let started = false
  let ready = null

  const keyOf = (r) => r.aliasID
  const compare = (a, b) =>
    String(a.aliasType ?? '').localeCompare(String(b.aliasType ?? '')) ||
    String(a.canonicalName ?? '').localeCompare(String(b.canonicalName ?? '')) ||
    String(a.aliasValue ?? '').localeCompare(String(b.aliasValue ?? ''))

  async function persist() {
    await cacheSet(CACHE_KEY.table('aliases'), { data: rows, etag: null, timestamp: Date.now() })
  }

  async function sync() {
    try {
      const res = await apiGet('/api/aliases')
      if (Array.isArray(res.data)) {
        rows = res.data
        logSync('aliases', `已更新 ${rows.length} 筆`)
        await persist()
      } else {
        console.warn('[sync] aliases 回應非陣列，保留現有資料', res.data)
      }
      synced = true
      error = null
    } catch (err) {
      error = err
      console.warn('[sync] aliases 取得失敗', err)
    } finally {
      loading = false
    }
  }

  function load() {
    if (started) return ready
    started = true
    ready = (async () => {
      loading = true
      const cached = await cacheGet(CACHE_KEY.table('aliases'))
      if (cached && Array.isArray(cached.data) && cached.data.length) {
        rows = isolate(cached.data)
        loading = false
        logSync('aliases', `IDB 命中 ${rows.length} 筆`)
      }
      await sync()
    })()
    return ready
  }

  return {
    get rows() {
      return rows
    },
    get loading() {
      return loading
    },
    get synced() {
      return synced
    },
    get error() {
      return error
    },
    keyOf,
    load,
    async reload() {
      started = true
      synced = false
      await sync()
    },
    applyLocalInsert(row) {
      rows = [...rows, row].sort(compare)
      return persist()
    },
    applyLocalUpdate(row) {
      const k = keyOf(row)
      rows = rows.map((r) => (keyOf(r) === k ? { ...r, ...row } : r)).sort(compare)
      return persist()
    },
    applyLocalDelete(keyOrRow) {
      const k = typeof keyOrRow === 'object' && keyOrRow !== null ? keyOf(keyOrRow) : keyOrRow
      rows = rows.filter((r) => keyOf(r) !== k)
      return persist()
    },
  }
}

export const aliases = createAliasesStore()

/* ========================= setlist（月度增量） ========================= */

const NONE_BUCKET = 'none'

/** 月度端點的 query：none bucket 走 from=none&to=none */
function monthQuery(month) {
  return month === NONE_BUCKET
    ? '/api/setlist?from=none&to=none'
    : `/api/setlist?from=${month}&to=${month}`
}

/** 指紋＝version + count + maxUpdated 串成不透明字串（maxUpdated 是 MySQL 原始字串，勿 parse） */
function fingerprintOf(version, entry) {
  return `${version ?? 'v?'}|${entry.count ?? 0}|${entry.maxUpdated ?? ''}`
}

/** 顯示序：月份 key 降序、none 殿後；月內沿用 API 回傳順序 */
function orderedMonthKeys(keys) {
  const real = keys.filter((k) => k !== NONE_BUCKET).sort().reverse()
  if (keys.includes(NONE_BUCKET)) real.push(NONE_BUCKET)
  return real
}

/** 由列的 time（ISO UTC）推月份 bucket——與後端 DATE_FORMAT(time,'%Y-%m') 同語意 */
function monthOfRow(row) {
  if (row && typeof row.time === 'string' && row.time.length >= 7) return row.time.slice(0, 7)
  return NONE_BUCKET
}

/** 月內排序：API 為 time DESC, segmentNo ASC, trackNo ASC（none bucket 再以 streamID 收尾） */
function compareSetlist(a, b) {
  const t = String(b.time ?? '').localeCompare(String(a.time ?? ''))
  if (t) return t
  return (
    (a.segmentNo ?? 0) - (b.segmentNo ?? 0) ||
    (a.trackNo ?? 0) - (b.trackNo ?? 0) ||
    String(a.streamID ?? '').localeCompare(String(b.streamID ?? ''))
  )
}

export const setlistKeyOf = (r) => `${r.streamID}/${r.segmentNo ?? 1}/${r.trackNo}`

function createSetlistStore() {
  let rows = $state.raw([])
  let monthKeys = $state.raw([]) // 顯示序的月份清單（reactive，供月份篩選 chip 用）
  let loading = $state(false)
  let synced = $state(false)
  let error = $state(null)

  /** 月份 → 該月列陣列（非 reactive，rows 才是對外的單一真相） */
  let months = new Map()
  let fingerprints = {} // month → 指紋字串
  let metaEtag = null
  let incomplete = false // 有月份缺 record（快取不完整）
  let started = false
  let ready = null

  /** months Map（非 reactive）→ 對外的兩個 reactive 快照：rows（扁平化）與 monthKeys */
  function republish() {
    const keys = orderedMonthKeys([...months.keys()])
    const out = []
    for (const key of keys) {
      const arr = months.get(key)
      if (!arr) continue
      for (const row of arr) out.push(row)
    }
    monthKeys = keys
    rows = out
  }

  async function persistMeta() {
    await cacheSet(CACHE_KEY.setlistMeta, {
      etag: metaEtag,
      fingerprints,
      months: [...months.keys()],
      timestamp: Date.now(),
    })
  }

  // 參數刻意不叫 monthKeys —— 避免遮蔽同名的 $state 變數
  async function persistMonths(keys) {
    await cacheSetMany(keys.map((m) => [CACHE_KEY.setlistMonth(m), months.get(m) ?? []]))
  }

  async function primeFromCache() {
    const meta = await cacheGet(CACHE_KEY.setlistMeta)
    if (!meta || !Array.isArray(meta.months) || meta.months.length === 0) return false

    const records = await cacheGetMany(meta.months.map((m) => CACHE_KEY.setlistMonth(m)))
    let missing = 0
    meta.months.forEach((m, i) => {
      const rec = records[i]
      if (Array.isArray(rec)) months.set(m, isolate(rec))
      else missing++
    })
    if (months.size === 0) return false

    fingerprints = meta.fingerprints ?? {}
    metaEtag = meta.etag ?? null
    incomplete = missing > 0
    if (incomplete) {
      // 缺月時本輪 sync 不得帶舊 ETag（304 會短路擋死自癒）
      console.warn(`[sync] setlist 快取缺 ${missing} 個月份 record，本次同步不帶 If-None-Match`)
    }
    republish()
    logSync('setlist', `IDB 命中 ${months.size} 個月 / ${rows.length} 筆`)
    return true
  }

  async function primeFromSnapshot() {
    const mani = await fetchSnapshot('manifest.json')
    const list = mani?.months
    if (!Array.isArray(list) || list.length === 0) return false

    const keys = list.map((m) => m.month)
    const fetched = await mapLimit(keys, 6, (m) =>
      fetchSnapshot(m === NONE_BUCKET ? 'setlist-none.json' : `setlist-${m}.json`),
    )

    const nextFingerprints = {}
    let missing = 0
    list.forEach((entry, i) => {
      const data = fetched[i]
      if (Array.isArray(data)) {
        months.set(entry.month, data)
        nextFingerprints[entry.month] = fingerprintOf(mani.version, entry)
      } else {
        missing++
      }
    })
    if (months.size === 0) return false

    fingerprints = nextFingerprints
    metaEtag = null // 靜態快照無 ETag
    incomplete = missing > 0
    republish()
    logSync('setlist', `快照命中 ${months.size} 個月 / ${rows.length} 筆`)

    await persistMonths([...months.keys()])
    await persistMeta()
    return true
  }

  async function sync({ force = false } = {}) {
    try {
      // 缺月（或強制）時一律不帶 ETag——帶舊 etag 命中 304 會提前 return，
      // 走不到指紋比對，缺月就永遠補不回來（現站教訓）
      const useEtag = !force && !incomplete && metaEtag ? metaEtag : null
      const res = await apiGet('/api/setlist/manifest', { etag: useEtag })

      if (res.notModified) {
        if (res.etag) metaEtag = res.etag
        synced = true
        error = null
        logSync('setlist', '無變更 (304)')
        return
      }

      const version = res.data?.version
      const list = Array.isArray(res.data?.months) ? res.data.months : []
      const nextFingerprints = {}
      const changed = []

      for (const entry of list) {
        const fp = fingerprintOf(version, entry)
        nextFingerprints[entry.month] = fp
        if (fingerprints[entry.month] !== fp || !months.has(entry.month)) changed.push(entry.month)
      }

      const removed = [...months.keys()].filter((m) => !(m in nextFingerprints))

      if (changed.length === 0 && removed.length === 0) {
        fingerprints = nextFingerprints
        metaEtag = res.etag ?? null
        incomplete = false
        await persistMeta()
        synced = true
        error = null
        logSync('setlist', '指紋一致，無需重抓')
        return
      }

      logSync('setlist', `變更 ${changed.length} 個月、移除 ${removed.length} 個月`, changed)

      // 只重抓變更月份（整月覆蓋重建）
      const failed = []
      await mapLimit(changed, 3, async (m) => {
        try {
          const monthRes = await apiGet(monthQuery(m))
          months.set(m, Array.isArray(monthRes.data) ? monthRes.data : [])
        } catch (err) {
          failed.push(m)
          console.warn(`[sync] setlist ${m} 月重抓失敗`, err)
        }
      })

      for (const m of removed) months.delete(m)
      if (removed.length) await cacheDelMany(removed.map((m) => CACHE_KEY.setlistMonth(m)))

      // 抓失敗的月份不寫入新指紋，下次同步會再視為變更 → 自癒
      for (const m of failed) delete nextFingerprints[m]
      fingerprints = nextFingerprints
      incomplete = failed.length > 0
      // 有月份沒抓成時不保留 ETag，否則下次 304 會擋死補抓
      metaEtag = incomplete ? null : (res.etag ?? null)

      republish()
      await persistMonths(changed.filter((m) => !failed.includes(m)))
      await persistMeta()

      synced = !incomplete
      error = null
      logSync('setlist', `已更新，共 ${rows.length} 筆`)
    } catch (err) {
      error = err
      console.warn('[sync] setlist 背景校正失敗', err)
    } finally {
      loading = false
    }
  }

  function load() {
    if (started) return ready
    started = true
    ready = (async () => {
      loading = true
      const primed = (await primeFromCache()) || (await primeFromSnapshot())
      if (primed) loading = false
      await sync()
    })()
    return ready
  }

  /** 依 composite key 找出所在月份 */
  function findMonthOf(key) {
    for (const [m, arr] of months) {
      if (arr.some((r) => setlistKeyOf(r) === key)) return m
    }
    return null
  }

  /** 新列的月份：優先用 time；沒有 time 時用同場既有列 / streamlist 的時間推 */
  function resolveMonth(row) {
    if (typeof row.time === 'string' && row.time.length >= 7) return row.time.slice(0, 7)
    for (const [m, arr] of months) {
      if (arr.some((r) => r.streamID === row.streamID)) return m
    }
    const stream = streamIndex.map.get(row.streamID)
    if (stream && typeof stream.time === 'string' && stream.time.length >= 7) {
      return stream.time.slice(0, 7)
    }
    return NONE_BUCKET
  }

  return {
    get rows() {
      return rows
    },
    get loading() {
      return loading
    },
    get synced() {
      return synced
    },
    get error() {
      return error
    },
    /** 月份清單（顯示序：YYYY-MM 降序、'none' 殿後），供月份篩選 chip 用 */
    get months() {
      return monthKeys
    },
    keyOf: setlistKeyOf,
    load,
    async reload() {
      started = true
      synced = false
      if (!rows.length) loading = true
      await sync({ force: true })
    },
    /** 只重抓單一月份（例如某場編輯完想確認） */
    async refreshMonth(month) {
      const res = await apiGet(monthQuery(month))
      months.set(month, Array.isArray(res.data) ? res.data : [])
      republish()
      await persistMonths([month])
    },
    applyLocalInsert(row) {
      const m = resolveMonth(row)
      const arr = [...(months.get(m) ?? []), row].sort(compareSetlist)
      months.set(m, arr)
      republish()
      return persistMonths([m])
    },
    applyLocalUpdate(row) {
      const key = setlistKeyOf(row)
      const m = findMonthOf(key)
      if (m == null) return Promise.resolve()
      months.set(
        m,
        months.get(m).map((r) => (setlistKeyOf(r) === key ? { ...r, ...row } : r)),
      )
      republish()
      return persistMonths([m])
    },
    applyLocalDelete(keyOrRow) {
      const key = typeof keyOrRow === 'object' && keyOrRow !== null ? setlistKeyOf(keyOrRow) : keyOrRow
      const m = findMonthOf(key)
      if (m == null) return Promise.resolve()
      months.set(
        m,
        months.get(m).filter((r) => setlistKeyOf(r) !== key),
      )
      republish()
      return persistMonths([m])
    },
  }
}

export const setlist = createSetlistStore()

/* ========================= yt/latest（首頁用） ========================= */

function createYtLatestStore() {
  let value = $state.raw(null)
  let loading = $state(false)
  let synced = $state(false)
  let error = $state(null)
  let started = false
  let ready = null

  async function sync() {
    try {
      const res = await apiGet('/api/yt/latest')
      value = res.data ?? null
      await cacheSet(CACHE_KEY.ytLatest, { data: value, timestamp: Date.now() })
      synced = true
      error = null
    } catch (err) {
      error = err
      console.warn('[sync] yt/latest 取得失敗', err)
    } finally {
      loading = false
    }
  }

  function load() {
    if (started) return ready
    started = true
    ready = (async () => {
      loading = true
      const cached = await cacheGet(CACHE_KEY.ytLatest)
      if (cached?.data) {
        value = isolate(cached.data)
        loading = false
      } else {
        const snap = await fetchSnapshot('yt-latest.json')
        if (snap) {
          value = snap
          loading = false
        }
      }
      await sync()
    })()
    return ready
  }

  return {
    get value() {
      return value
    },
    get loading() {
      return loading
    },
    get synced() {
      return synced
    },
    get error() {
      return error
    },
    load,
    async reload() {
      started = true
      synced = false
      await sync()
    },
  }
}

export const ytLatest = createYtLatestStore()

/* ========================= 客端 join / 索引 ========================= */

const _streamIndex = $derived.by(() => {
  const map = new Map()
  for (const s of streamlist.rows) map.set(s.streamID, s)
  return map
})

const _songIndex = $derived.by(() => {
  const map = new Map()
  for (const s of songlist.rows) map.set(s.songID, s)
  return map
})

/** streamID → streamlist 列（title / categories / time / setlistComplete） */
export const streamIndex = {
  get map() {
    return _streamIndex
  },
}

/** songID → songlist 列（含 genre / tieup / songNote 等 VIEW 沒有的欄位） */
export const songIndex = {
  get map() {
    return _songIndex
  },
}

/** setlist VIEW 不含 streamTitle，需客端 join streamlist 才拿得到場次標題 */
export function streamTitleOf(streamID) {
  return _streamIndex.get(streamID)?.title ?? null
}

const _setlistJoined = $derived.by(() => {
  const map = _streamIndex
  return setlist.rows.map((r) => {
    const s = map.get(r.streamID)
    return s
      ? {
          ...r,
          streamTitle: s.title ?? null,
          streamCategories: s.categories ?? null,
          setlistComplete: s.setlistComplete ?? null,
        }
      : { ...r, streamTitle: null, streamCategories: null, setlistComplete: null }
  })
})

/**
 * setlist + streamlist.title 的 join 結果（reactive、lazy）。
 * 表格只要顯示標題就用它；只需要少數幾列時用 streamTitleOf() 比較省。
 * ⚠️ 需先 setlist.load() 與 streamlist.load()。
 */
export const setlistJoined = {
  get rows() {
    return _setlistJoined
  },
}

/* ========================= 寫入後的列組裝 helper ========================= */

/** YTLink：startTime 為 null 時後端 VIEW 可能給不完整的值，這裡自行組一份安全的 */
export function buildYTLink(streamID, startTime) {
  if (!streamID) return null
  const base = `https://www.youtube.com/watch?v=${encodeURIComponent(streamID)}`
  return Number.isFinite(startTime) && startTime != null ? `${base}&t=${startTime}` : base
}

/** 渲染前檢查（SPEC-api §1）：非 https 開頭一律不當連結用 */
export function safeYTLink(row) {
  const link = row?.YTLink
  return typeof link === 'string' && link.startsWith('https://') ? link : buildYTLink(row?.streamID, row?.startTime)
}

/**
 * POST /api/setlist 的 201 回應是 setlist_ori 原始 row（不含 join 欄位）。
 * 用本地 songlist / streamlist 補齊成 VIEW 形狀，再交給 setlist.applyLocalInsert()。
 */
export function hydrateSetlistRow(ori) {
  const stream = _streamIndex.get(ori.streamID)
  const song = ori.songID != null ? _songIndex.get(ori.songID) : null
  return {
    streamID: ori.streamID,
    segmentNo: ori.segmentNo ?? 1,
    trackNo: ori.trackNo,
    songID: ori.songID ?? null,
    note: ori.note ?? null,
    startTime: ori.startTime ?? null,
    endTime: ori.endTime ?? null,
    time: stream?.time ?? null,
    songName: song?.songName ?? null,
    songNameEn: song?.songNameEn ?? null,
    artist: song?.artist ?? null,
    artistEn: song?.artistEn ?? null,
    YTLink: buildYTLink(ori.streamID, ori.startTime ?? null),
  }
}

/* ========================= 便利：一次載入常用表 ========================= */

/** setlist 頁需要 setlist + streamlist（join 標題）＋ songlist（選歌） */
export function loadAll() {
  return Promise.allSettled([songlist.load(), streamlist.load(), setlist.load(), aliases.load()])
}

/* ========================= 寫入捷徑（自動帶 X-Source 等慣例） ========================= */

/** POST /api/setlist（client.js 會自動帶 X-Source: user） */
export function createSetlistEntry(payload) {
  return apiPost('/api/setlist', payload)
}
