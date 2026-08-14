// 資料層核心 — 三層瀑布：IndexedDB → CDN 快照 → API 背景增量校正
//
// 對外每張表都是同一組介面（見檔案末尾的 export 摘要）：
//   store.rows / store.loading / store.synced / store.error   ← reactive（$state.raw）
//   store.load()      冪等，首次呼叫啟動瀑布；重複呼叫回同一個 promise
//   store.reload()    強制忽略 ETag 重抓（工具列「重新載入」用）；setlist 另會清空月度
//                     指紋＝全月重抓，讓「重新載入」對寫壞的月度快取真的有救
//   store.applyLocalInsert(row) / applyLocalUpdate(row) / applyLocalDelete(key)
//     ↑ 寫 API 成功後呼叫：更新記憶體 rows ＋ IndexedDB，不重抓
//   setlist.applyLocalBatch(rows)   批次寫入後的一次性套用（多列／跨月一次算完）
//
// 同一個 store 的 sync 有 in-flight 去重（createSyncGate）：進行中重複呼叫回同一個
// promise，force（reload）排在當前那發之後跑一次。
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
import { ApiError, apiGet, apiPost, fetchSnapshot } from './client.js'

/* ========================= IndexedDB（可用性降級） ========================= */

// DB / store 名沿用現站（berry-cache / tables），快取與現站互不干擾但慣例一致
let idbStore = null
let idbAvailable = true
let idbWarned = false

/**
 * 連續「暫時性」失敗的計數。IDB 的失敗有兩種性質，混在一起處理會過度降級：
 *   結構性：createStore 就 throw（私密視窗／環境禁用）＝這個瀏覽期永遠不可能成功 → 立刻永久降級
 *   暫時性：單次逾時、配額暫時不足、交易被中止（背景頁面被凍結、磁碟壓力）
 *           → 只跳過這一次，成功一次就歸零；連續 3 次才認定壞掉
 * 舊寫法一次逾時就永久關閉快取，之後整個 session 每頁都全量重抓（回訪秒開直接沒了）。
 */
let idbSoftFailures = 0
const IDB_SOFT_FAIL_LIMIT = 3

try {
  idbStore = createStore('berry-cache', 'tables')
} catch (err) {
  noteIdbFailure(err, { permanent: true })
}

function warnIdbOnce(err) {
  if (idbWarned) return
  idbWarned = true
  console.warn('[cache] IndexedDB 不可用，降級為「快照 + API 直抓」（私密視窗屬正常情況）', err)
}

/** 逾時／配額／交易中止＝暫時性；其餘（含未知型別）保守視為結構性 */
function isTransientIdbError(err) {
  if (err?.idbTimeout) return true
  const name = err?.name
  return (
    name === 'QuotaExceededError' ||
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    name === 'TransactionInactiveError' ||
    name === 'UnknownError' // Safari/Firefox 在磁碟壓力下丟這個
  )
}

function noteIdbFailure(err, { permanent = false } = {}) {
  if (permanent || !isTransientIdbError(err)) {
    idbAvailable = false
    warnIdbOnce(err)
    return
  }
  idbSoftFailures++
  if (idbSoftFailures >= IDB_SOFT_FAIL_LIMIT) {
    idbAvailable = false
    warnIdbOnce(err)
    return
  }
  console.warn(
    `[cache] IndexedDB 操作失敗（暫時性 ${idbSoftFailures}/${IDB_SOFT_FAIL_LIMIT}），本次跳過`,
    err,
  )
}

// 某些被鎖住的瀏覽器環境 IDB 不 throw 而是永不 resolve——不設限會卡死整條載入瀑布。
// 讀取要快（擋在首屏前面）；寫入放寬——setlist 一次寫十幾個月份 record（數 MB），
// 老機器／磁碟忙碌時 2s 根本不夠，逾時就等於「明明寫得完卻永久關掉快取」。
const IDB_READ_TIMEOUT_MS = 2000
const IDB_WRITE_TIMEOUT_MS = 8000

function withIdbTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`IndexedDB 操作逾時（>${ms}ms）`)
      err.idbTimeout = true // ← noteIdbFailure 據此判為暫時性
      reject(err)
    }, ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** 所有 IDB 操作的單一出口：逾時保護 ＋ 失敗分類 ＋ 成功歸零計數。回 { ok, value } */
async function runIdb(makePromise, timeoutMs) {
  if (!idbAvailable) return { ok: false, value: undefined }
  try {
    const value = await withIdbTimeout(makePromise(), timeoutMs)
    idbSoftFailures = 0
    return { ok: true, value }
  } catch (err) {
    noteIdbFailure(err)
    return { ok: false, value: undefined }
  }
}

async function cacheGet(key) {
  const { value } = await runIdb(() => idbGet(key, idbStore), IDB_READ_TIMEOUT_MS)
  return value
}

async function cacheGetMany(keys) {
  if (keys.length === 0) return []
  const { ok, value } = await runIdb(() => idbGetMany(keys, idbStore), IDB_READ_TIMEOUT_MS)
  return ok ? value : keys.map(() => undefined)
}

async function cacheSet(key, value) {
  await runIdb(() => idbSet(key, value, idbStore), IDB_WRITE_TIMEOUT_MS)
}

async function cacheSetMany(entries) {
  if (entries.length === 0) return
  await runIdb(() => idbSetMany(entries, idbStore), IDB_WRITE_TIMEOUT_MS)
}

async function cacheDelMany(keys) {
  if (keys.length === 0) return
  await runIdb(() => idbDelMany(keys, idbStore), IDB_WRITE_TIMEOUT_MS)
}

/**
 * 「寫 IDB 但不擋關鍵路徑」——快照灌入後的落地屬於這類：使用者已經看到資料，
 * 接下來該去打 API 校正，沒有理由等一個最長 8s 的寫入。
 * 錯誤只記錄（cacheSet* 內部已吞掉 IDB 錯誤，這裡是最後一道保險）。
 */
function persistInBackground(promise, tag) {
  Promise.resolve(promise).catch((err) => console.warn(`[cache] ${tag} 背景寫入失敗`, err))
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

/**
 * sync 的 in-flight 去重（三個 store 共用）。
 *
 * 同一輪校正被重複呼叫的情境很常見：頁面 load() 與 Analytics 的 reload()、
 * SyncStatus 的重新載入鈕被連按、多個元件各自 load()。兩發同時跑會互相覆寫
 * ETag／指紋（後回的那發帶著過期的 baseline 寫結果），也白花請求。
 *
 * 規則：
 *   · 進行中又被呼叫（非 force）→ 回同一個 promise，不發第二次請求
 *   · force（使用者按「重新載入」）不可被去重掉——他要的是「現在重抓」，
 *     所以排在當前那發之後執行一次；期間累積的多發 force 併成一次
 */
function createSyncGate(syncFn) {
  let inflight = null
  let queuedForce = null

  function run(options = {}) {
    if (inflight) {
      if (!options.force) return inflight
      if (!queuedForce) {
        const after = () => {
          queuedForce = null
          return run({ ...options, force: true })
        }
        queuedForce = inflight.then(after, after)
      }
      return queuedForce
    }
    const p = Promise.resolve()
      .then(() => syncFn(options))
      .finally(() => {
        if (inflight === p) inflight = null
      })
    inflight = p
    return p
  }

  return run
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
      // IDB 的每次 get 都是重新反序列化的新物件（IndexedDB 規格保證：寫入時 structured
      // clone、讀取時逐次 deserialize），不與其他讀取共用參照 ⇒ 不需要再 structuredClone
      // 一份（三萬列的深拷貝，回訪秒開最貴的一步）。就地 mutate rows 本來就是禁止的
      // （$state.raw，見檔頭），而 API／快照路徑一向也沒有拷貝這層防護。
      rows = cached.data
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
      persistInBackground(persist(), `${type} 快照`) // 不擋 API 校正（見 persistInBackground）
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

  const requestSync = createSyncGate(sync)

  function load() {
    if (started) return ready
    started = true
    ready = (async () => {
      loading = true
      const primed = (await primeFromCache()) || (await primeFromSnapshot())
      if (primed) loading = false
      await requestSync()
    })()
    return ready
  }

  async function reload() {
    started = true
    if (!rows.length) loading = true
    synced = false
    await requestSync({ force: true })
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

  const requestSync = createSyncGate(sync)

  function load() {
    if (started) return ready
    started = true
    ready = (async () => {
      loading = true
      const cached = await cacheGet(CACHE_KEY.table('aliases'))
      if (cached && Array.isArray(cached.data) && cached.data.length) {
        rows = cached.data // IDB get 已是新物件，無需再拷貝（見 createEtagTable.primeFromCache）
        loading = false
        logSync('aliases', `IDB 命中 ${rows.length} 筆`)
      }
      await requestSync()
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
      // aliases 無 ETag：sync() 本來就是整包重抓，force 只用來繞過 in-flight 去重
      await requestSync({ force: true })
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

  /**
   * 月度寫入的併發仲裁（sync 的月度重抓與 refreshMonth 會撞同一個月）。
   *
   * 設計：每次「開始抓某月」領一個全域單調遞增號碼並記在 monthClaim；結果回來時
   * 只有仍是該月最後領號者才准寫入 months —— **舊請求晚回不得覆蓋新結果**
   * （批次表單送出前的重抓與 drawer 開啟時的重抓相隔幾秒，慢的那發若後回就會把
   * 新鮮資料換成舊的，prefill 據此比對＝把使用者擋在門外或洗掉別人的資料）。
   *
   * monthInflight 只用在「我輸了」的分支：等贏家落地再 resolve，讓呼叫端
   * `await refreshMonth()` 之後看到的資料保證不比自己這一發舊。
   */
  let claimSeq = 0
  const monthClaim = new Map() // month → 最後領號
  const monthInflight = new Map() // month → 最後一發的 task promise

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

  /**
   * 把某月的權威資料寫進 months，並把「這批列涉及的場次」從**其他**月份清掉。
   * 回傳被動到的月份陣列（呼叫端據此 persist）。
   *
   * 為什麼要跨月清：一場的月份 bucket 由 streamlist.time 決定，站主改了開播時間
   * （或不留檔場補上時間）該場就換 bucket。只覆蓋新 bucket 的話舊 bucket 的 record
   * 還留著同一場的舊列 ⇒ 同一場在快取裡出現兩份（rows 重複、批次 prefill 可能撈到
   * 舊值寫回去）。一場只能屬於一個 bucket，這裡就是維持該不變量的地方。
   */
  function adoptMonthRows(month, list) {
    months.set(month, list)
    const touched = [month]
    const ids = new Set(list.map((r) => r.streamID))
    if (ids.size === 0) return touched
    for (const [m, arr] of months) {
      if (m === month) continue
      const kept = arr.filter((r) => !ids.has(r.streamID))
      if (kept.length !== arr.length) {
        months.set(m, kept) // 更新既有 key：Map 迭代中安全
        touched.push(m)
      }
    }
    return touched
  }

  /**
   * 抓單一月份並寫進 months（不 republish、不 persist——由呼叫端統一做一次）。
   * @returns {Promise<string[]|null>} 被動到的月份；null＝領號過期（結果作廢）
   * @throws 網路錯誤，或 200 但回應非陣列（SPA fallback 的 HTML、信封走形）——
   *   **絕不可把非陣列當成空陣列寫入**：那會把該月抹成 0 筆，而且指紋照樣寫下去，
   *   下輪 sync 比對一致 ⇒ 資料憑空消失且永不自癒。
   */
  async function fetchMonthIntoMap(month) {
    const seq = ++claimSeq
    monthClaim.set(month, seq)
    const res = await apiGet(monthQuery(month))
    if (!Array.isArray(res.data)) {
      throw new ApiError(`setlist ${month} 月端點回應非陣列`, {
        code: 'INVALID_SHAPE',
        status: res.status ?? 0,
      })
    }
    if (monthClaim.get(month) !== seq) {
      logSync('setlist', `${month} 月結果過期（seq ${seq}），丟棄`)
      return null
    }
    return adoptMonthRows(month, res.data)
  }

  async function primeFromCache() {
    const meta = await cacheGet(CACHE_KEY.setlistMeta)
    if (!meta || !Array.isArray(meta.months) || meta.months.length === 0) return false

    const records = await cacheGetMany(meta.months.map((m) => CACHE_KEY.setlistMonth(m)))
    let missing = 0
    meta.months.forEach((m, i) => {
      const rec = records[i]
      // IDB get 已回新物件，不再多做一次 structuredClone（見 createEtagTable.primeFromCache）
      if (Array.isArray(rec)) months.set(m, rec)
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

    // 十幾個月份 record（數 MB）的落地不擋關鍵路徑——使用者已看到資料，
    // 下一步該去打 manifest 校正，沒理由在這裡等一個最長 8s 的寫入
    persistInBackground(
      persistMonths([...months.keys()]).then(persistMeta),
      'setlist 快照',
    )
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
      const list = res.data?.months

      // 200 但形狀不對（SPA fallback 回 HTML、信封走形、走錯 origin）。
      // ⚠️ 舊寫法在這裡退成 `[]`：removed 就等於「全部現有月份」，接著整包 months
      //    與 IDB record 一起被刪光——一次走形的回應就把使用者的快取清空。
      //    保留現有資料、不動指紋／ETag，本輪等於沒校驗（synced 不推進）。
      if (!Array.isArray(list)) {
        console.warn('[sync] setlist manifest 回應非陣列，保留現有資料', res.data)
        error = new ApiError('setlist manifest 回應格式不正確', {
          code: 'INVALID_SHAPE',
          status: res.status ?? 0,
        })
        return
      }

      // force（使用者按「重新載入」）：指紋全清，每個月都當成變更重抓一次。
      // 不清的話 force 只是「重問 manifest」——指紋一致就什麼都不重抓，
      // 使用者眼中的「重新載入」對已經寫壞的月度 record 毫無效果（不是自救）。
      // 代價：一次 73 發月度請求、實測約 4s（併發 3）。這是使用者明確要求的動作，
      // 且是唯一能修好「內容壞掉但指紋看起來一致」的手段，值得。
      const baseline = force ? {} : fingerprints
      if (force) logSync('setlist', '強制重新載入：清空月度指紋，全月重抓')

      const nextFingerprints = {}
      const changed = []

      for (const entry of list) {
        const fp = fingerprintOf(version, entry)
        nextFingerprints[entry.month] = fp
        if (baseline[entry.month] !== fp || !months.has(entry.month)) changed.push(entry.month)
      }

      const removed = [...months.keys()].filter((m) => !(m in nextFingerprints))

      // 保險絲：manifest 說「你手上每一個月都不存在了」而且沒有任何月份變更——
      // 正常的月份消失一定伴隨其他月份的資料變動（或至少不會全滅）。這個形狀更可能是
      // 打到別的 API／空回應，寧可少刪不可全清（資料在手上不會壞，刪掉要重抓才回來）。
      // 代價：快取只有單一月份時的「合法整月清空」也會被擋一輪（下輪 sync 再處理）。
      if (months.size > 0 && removed.length === months.size && changed.length === 0) {
        console.warn(
          `[sync] setlist manifest 要求移除全部 ${removed.length} 個月份且無任何變更，視為異常拒絕執行`,
          res.data,
        )
        error = new ApiError('setlist manifest 內容異常（要求清空全部月份）', {
          code: 'SUSPICIOUS_MANIFEST',
          status: res.status ?? 0,
        })
        return
      }

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
      const touched = new Set()
      await mapLimit(changed, 3, async (m) => {
        try {
          // 非陣列會 throw（fetchMonthIntoMap），併入 failed 走既有的「刪指紋 → 下輪自癒」，
          // 不再靜默寫成空陣列
          const written = await fetchMonthIntoMap(m)
          if (written) for (const t of written) touched.add(t)
          // written === null＝有更晚的請求（refreshMonth）已領號並會自己寫入，
          // 本輪不碰這個月的資料，但指紋照樣寫（manifest 的真值就是這個 fp）
        } catch (err) {
          failed.push(m)
          console.warn(`[sync] setlist ${m} 月重抓失敗`, err)
        }
      })

      for (const m of removed) {
        months.delete(m)
        monthClaim.delete(m)
        monthInflight.delete(m)
        touched.delete(m)
      }
      if (removed.length) await cacheDelMany(removed.map((m) => CACHE_KEY.setlistMonth(m)))

      // 抓失敗的月份不寫入新指紋，下次同步會再視為變更 → 自癒
      for (const m of failed) delete nextFingerprints[m]
      fingerprints = nextFingerprints
      incomplete = failed.length > 0
      // 有月份沒抓成時不保留 ETag，否則下次 304 會擋死補抓
      metaEtag = incomplete ? null : (res.etag ?? null)

      republish()
      // touched 含跨月清理波及到的月份（adoptMonthRows），不只 changed
      await persistMonths([...touched])
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

  const requestSync = createSyncGate(sync)

  function load() {
    if (started) return ready
    started = true
    ready = (async () => {
      loading = true
      const primed = (await primeFromCache()) || (await primeFromSnapshot())
      if (primed) loading = false
      await requestSync()
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

  /** 快取裡有這場資料的月份（找不到回 null）——沒有 time 可用時的退路 */
  function monthOfStreamID(streamID) {
    if (streamID == null) return null
    for (const [m, arr] of months) {
      if (arr.some((r) => r.streamID === streamID)) return m
    }
    return null
  }

  /**
   * 該月份的快取「在上一輪校驗當下」可不可信 —— 三個條件缺一不可：
   *   synced       上一輪 manifest 校驗已完成，且沒有月份重抓失敗
   *   months.has   該月 record 真的在手（缺月自癒尚未完成時為 false）
   *   fingerprints 該月指紋已寫入（重抓失敗的月份會被刪掉指紋等下次自癒）
   * 只看 rows.length 非零會同時吃到「過時」與「缺月＝假的沒資料」兩種假象。
   *
   * ⚠️ 保證的範圍僅止於「上一輪校驗當下是最新」，**不是「此刻仍是最新」**：
   *    `synced` 是黏著的（成功後只有 reload()／下一輪 sync 會再動它），頁面開著很久、
   *    期間 cron（歌單解析／時間戳回補）或他人寫入了新資料，這裡照樣回 true。
   *    需要「此刻的真值」時（例如全覆寫寫入前的防覆蓋檢查）必須自己 refreshMonth()
   *    重抓再比對——範例見 SetList 批次表單的 batchFreshPhase。
   */
  function isMonthComplete(month) {
    return synced && months.has(month) && Object.hasOwn(fingerprints, month)
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
    /** 月份（'YYYY-MM' 或 'none'）的快取是否完整且已校驗 */
    isMonthComplete,
    /**
     * 某一場的歌單能否直接吃快取（拿快取當「這場的完整歌單」用之前必問）。
     * @param {string} streamID
     * @param {string|null} [time] 該場的 time（ISO UTC；不留檔場為 null → 'none' bucket）。
     *   沒給就用快取裡找得到該場列的月份推，再退回 'none'。
     */
    hasCompleteDataFor(streamID, time) {
      const month =
        typeof time === 'string' && time.length >= 7
          ? time.slice(0, 7)
          : (monthOfStreamID(streamID) ?? NONE_BUCKET)
      return isMonthComplete(month)
    },
    load,
    async reload() {
      started = true
      synced = false
      if (!rows.length) loading = true
      // force：manifest 不帶 ETag ＋ 月度指紋全清（見 sync 內 baseline）＝ 全月重抓，
      // 「重新載入」因此對寫壞／過時的月度 record 真的有救
      await requestSync({ force: true })
    },
    /**
     * 只重抓單一月份（reorder 之後、批次表單開啟／送出前的新鮮度確認）。
     *
     * · 200 但非陣列＝throw（呼叫端都有 catch）：寫成空陣列會讓該月憑空消失，
     *   而且下輪 sync 指紋一致就永不自癒
     * · 成功後刪掉該月指紋並標記 incomplete：手上這份沒經過 manifest 校驗，
     *   誠實標成「未知」，下一輪 sync（不帶 ETag）會重驗；不刪的話快取狀態會謊稱
     *   「這個月已校驗」，而 isMonthComplete 是別人拿快取當真值的依據
     * · 併發：見 monthClaim / monthInflight 的說明。與 sync 的月度重抓撞同月時兩者
     *   的收尾都是自洽狀態（指紋在＋incomplete=false，或指紋不在＋incomplete=true），
     *   最壞情況只是多一次重抓，不會出現「指紋說已校驗但資料是舊的」
     */
    async refreshMonth(month) {
      const task = (async () => {
        const touched = await fetchMonthIntoMap(month)
        if (!touched) {
          // 領號過期：更晚的那發才是真值。等它落地再回，呼叫端 await 完看到的資料
          // 保證不比自己這一發舊（否則 prefill／簽章比對會拿到被作廢的舊快照）
          await Promise.resolve(monthInflight.get(month)).catch(() => {})
          return
        }
        republish()
        delete fingerprints[month]
        incomplete = true
        // ETag 一起丟掉，否則「指紋缺一個月 ＋ meta ETag 還在」＝下輪 manifest 拿 304
        // 提前 return，永遠走不到指紋比對，這個月就再也驗不回來（跨 session 也一樣，
        // primeFromCache 的 incomplete 只看 record 缺不缺、看不到指紋缺不缺）。
        // 同 sync 內「有月份沒抓成就不保留 ETag」的既有紀律。
        metaEtag = null
        await persistMonths(touched)
        await persistMeta() // 月份清單／指紋都變了：新月份 record 不能成為 IDB 孤兒
      })()
      monthInflight.set(month, task)
      return task
    },
    applyLocalInsert(row) {
      const m = resolveMonth(row)
      const isNewMonth = !months.has(m)
      const arr = [...(months.get(m) ?? []), row].sort(compareSetlist)
      months.set(m, arr)
      republish()
      // 新月份必須同步更新 meta 的 months 清單，否則 record 是孤兒
      // （下次開站 primeFromCache 只讀 meta.months，這個月的資料永遠讀不到）
      return isNewMonth
        ? Promise.all([persistMonths([m]), persistMeta()])
        : persistMonths([m])
    },
    applyLocalUpdate(row) {
      const key = setlistKeyOf(row)
      const m = findMonthOf(key)
      if (m == null) {
        // 快取裡沒有這列＝呼叫端的假設已經不成立（該月被 removed／快取缺月／key 算錯）。
        // 靜默 return 會讓「儲存成功但畫面沒變」查不出原因
        console.warn('[cache] setlist applyLocalUpdate 找不到該列所屬月份，略過本地更新', key)
        return Promise.resolve()
      }
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
      if (m == null) {
        console.warn('[cache] setlist applyLocalDelete 找不到該列所屬月份，略過本地刪除', key)
        return Promise.resolve()
      }
      months.set(
        m,
        months.get(m).filter((r) => setlistKeyOf(r) !== key),
      )
      republish()
      return persistMonths([m])
    },
    /**
     * 批次寫入後的本地套用：一次算完所有受影響月份 → 一次 republish → 一次 persist。
     *
     * 逐列呼叫 applyLocalUpdate/Insert 的成本是每列一次 findMonthOf（O(月×列)）、
     * 一次 republish（重建整個 rows 陣列 ~3 萬列）與一次 IDB 寫入——20 列的批次
     * 等於 20 次全表重建。語意與逐列版本一致：composite key 已存在＝merge（patch），
     * 不存在＝插入（月份用 resolveMonth 推、月內重新排序）。
     *
     * @param {object[]} list VIEW 形狀的列（POST 回應請先過 hydrateSetlistRow）
     */
    applyLocalBatch(list) {
      if (!Array.isArray(list) || list.length === 0) return Promise.resolve()

      // key → 所在月份：整個快取只掃一次（取代每列一次 findMonthOf）
      const keyMonth = new Map()
      for (const [m, arr] of months) for (const r of arr) keyMonth.set(setlistKeyOf(r), m)

      const patches = new Map() // key → 要 merge 進去的列
      const inserts = new Map() // month → 新列
      const touched = new Set()
      let metaChanged = false

      for (const row of list) {
        const key = setlistKeyOf(row)
        const m = keyMonth.get(key)
        if (m != null) {
          patches.set(key, row)
          touched.add(m)
        } else {
          const target = resolveMonth(row)
          if (!inserts.has(target)) inserts.set(target, [])
          inserts.get(target).push(row)
          touched.add(target)
        }
      }

      for (const m of touched) {
        const arr = months.get(m)
        if (!arr) metaChanged = true // 全新月份 → meta 的 months 清單要一起更新
        let next = arr ?? []
        if (patches.size) {
          next = next.map((r) => {
            const patch = patches.get(setlistKeyOf(r))
            return patch ? { ...r, ...patch } : r
          })
        }
        const adds = inserts.get(m)
        if (adds?.length) next = [...next, ...adds].sort(compareSetlist)
        months.set(m, next)
      }

      republish()
      const keys = [...touched]
      return metaChanged
        ? Promise.all([persistMonths(keys), persistMeta()])
        : persistMonths(keys)
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
        value = cached.data // IDB get 已是新物件（見 createEtagTable.primeFromCache）
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
