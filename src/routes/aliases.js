/**
 * @fileoverview Aliases management API routes
 * @description Provides CRUD operations for artist and title aliases
 * @features No caching, real-time database queries, direct error throwing
 */

import { Hono } from 'hono'
import { validateLengths, FIELD_LIMITS } from '../utils/middleware.js'

const app = new Hono()

// Length caps for the alias write paths.
// canonicalName/aliasValue are varchar(512); note is TEXT and the batch endpoint
// accepts up to 100 records per request, so the program-level cap is the only bound.
const ALIAS_FIELD_LIMITS = {
  canonicalName: FIELD_LIMITS.canonicalName,
  aliasValue: FIELD_LIMITS.aliasValue,
  note: FIELD_LIMITS.aliasNote
}

// 對外的欄位清單（不用 SELECT *）：`songKey`（GENERATED AS COALESCE(songID, 0) STORED）
// 只是 UNIQUE (aliasType, canonicalName, aliasValue, songKey) 的載體，是內部防重機制，
// 不進 API 輸出——多這一欄前端要嘛忽略要嘛誤用，兩者都沒好處。
const ALIAS_COLUMNS =
  'aliasID, aliasType, canonicalName, aliasValue, songID, note, createdAt, updatedAt'

/**
 * GET /aliases
 * Get all aliases (flat list for Tabulator)
 * @returns {Array} Array of alias records
 */
app.get('/', async (c) => {
  const db = c.get('db')

  try {
    // songID 排在末位排序鍵：新 UNIQUE 含 songKey 之後，同一組 (type, canonical, value)
    // 可綁不同歌並存多筆，沒有第四鍵順序就不穩定
    const sql = `
      SELECT ${ALIAS_COLUMNS}
      FROM aliases
      ORDER BY aliasType, canonicalName, aliasValue, songID
    `

    const aliases = await db.query(sql)

    return c.json({
      success: true,
      data: aliases,
      count: aliases.length
    })
  } catch (error) {
    console.error('GET /aliases error:', error)
    return c.json(
      {
        success: false,
        error: {
          message: 'Failed to fetch aliases'
        }
      },
      500
    )
  }
})

/**
 * GET /aliases/grouped
 * Get grouped format for Worker fuzzy matching
 * Format: { artistAliases: { "釘宮理恵": ["kugimiya rie", ...] }, titleAliases: {...} }
 * @returns {Object} Grouped aliases data
 */
app.get('/grouped', async (c) => {
  const db = c.get('db')

  try {
    // 明列欄位：只取分組需要的四欄（songKey 為內部生成欄位，不外流）
    const sql = `
      SELECT aliasType, canonicalName, aliasValue, songID
      FROM aliases
      ORDER BY aliasType, canonicalName
    `

    const aliases = await db.query(sql)

    // Group aliases by type and canonical name
    // titleAliasesByID：alias 綁定 songID 的精準對應（同名異曲不互染），
    // titleAliases（字串 key）保留供輸入側展開與未綁定 songID 的 alias fallback
    const grouped = {
      artistAliases: {},
      titleAliases: {},
      titleAliasesByID: {}
    }

    // 新 UNIQUE 含 songKey ⇒ 同一組 (type, canonical, value) 可綁不同 songID 並存多筆。
    // 字串 key 的兩張表不看 songID，同名異曲的別名在這裡會長得一模一樣 ⇒ 必須去重
    //（重複值不影響比對正確性，但會讓 matcher 白跑同一個變體、輸出也髒）
    const pushUnique = (map, key, value) => {
      if (!map[key]) map[key] = []
      if (!map[key].includes(value)) map[key].push(value)
    }

    for (const alias of aliases) {
      const targetMap =
        alias.aliasType === 'artist'
          ? grouped.artistAliases
          : grouped.titleAliases

      pushUnique(targetMap, alias.canonicalName, alias.aliasValue)

      if (alias.aliasType === 'title' && alias.songID != null) {
        pushUnique(grouped.titleAliasesByID, String(alias.songID), alias.aliasValue)
      }
    }

    return c.json({
      success: true,
      data: grouped
    })
  } catch (error) {
    console.error('GET /aliases/grouped error:', error)
    // Direct error throwing - no degradation
    return c.json(
      {
        success: false,
        error: {
          message: 'Aliases API unavailable'
        }
      },
      500
    )
  }
})

/**
 * POST /aliases/quick-add
 * Quick add alias from setlist integration
 * @body {aliasType, canonicalName, aliasValue, note?}
 * @returns {Object} Created alias record
 */
app.post('/quick-add', async (c) => {
  const db = c.get('db')

  try {
    const body = await c.req.json()
    const { aliasType, canonicalName, aliasValue, note, songID } = body

    // Validation
    if (!aliasType || !['artist', 'title'].includes(aliasType)) {
      return c.json(
        {
          success: false,
          error: {
            message: 'Invalid aliasType',
            details: 'aliasType must be "artist" or "title"'
          }
        },
        400
      )
    }

    if (!canonicalName || !aliasValue) {
      return c.json(
        {
          success: false,
          error: {
            message: 'Missing required fields',
            details: 'canonicalName and aliasValue are required'
          }
        },
        400
      )
    }

    const lengthError = validateLengths(body, ALIAS_FIELD_LIMITS)
    if (lengthError) {
      return c.json(
        {
          success: false,
          error: {
            message: 'Invalid input',
            details: lengthError
          }
        },
        400
      )
    }

    // Insert alias（songID 為 title alias 的精準綁定，欄位由 migration 加入 —— 動態組欄避免 migration 前報錯）
    const hasSongID = songID !== undefined && songID !== null
    const targetSongID = hasSongID ? Number(songID) : null
    // songID 欄位是否可用（migration 前的降級旗標，見下方 catch）
    let songIDSupported = true

    // ── upsert 前先看同 (type, canonical, value) 的既有列 ────────────────────
    // UNIQUE 已改為 (aliasType, canonicalName, aliasValue, songKey)，同一個別名寫法
    // 可以綁不同 songID 並存多筆 ⇒ 這一組查詢有兩個用途：
    //   ① isNew：affectedRows 在「值完全沒變的 upsert」會是 0，判不出是新增或既有，
    //      改以「這個 songID 組合本來在不在」為準
    //   ② alsoBoundTo：同寫法但綁在**其他歌曲**上的 songID（告知性——新 UNIQUE 下
    //      不再有「搶綁定」，那些列原封不動）
    // 預查與 upsert 之間不是原子的，並發下 isNew/alsoBoundTo 可能微幅失準；
    // 兩者都只是提示用途，DB 的唯一性由 UNIQUE 保證。
    let siblings = []
    try {
      siblings = await db.query(
        `SELECT songID FROM aliases
         WHERE aliasType = ? AND canonicalName = ? AND aliasValue = ?`,
        [aliasType, canonicalName.trim(), aliasValue.trim()]
      )
    } catch (e) {
      if (!/Unknown column/i.test(e.message)) throw e
      songIDSupported = false
    }

    const sql = hasSongID
      ? `INSERT INTO aliases (aliasType, canonicalName, aliasValue, note, songID)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           note = VALUES(note), songID = VALUES(songID),
           updatedAt = CURRENT_TIMESTAMP(6)`
      : `INSERT INTO aliases (aliasType, canonicalName, aliasValue, note)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           note = VALUES(note),
           updatedAt = CURRENT_TIMESTAMP(6)`

    const params = [aliasType, canonicalName.trim(), aliasValue.trim(), note || null]
    if (hasSongID) params.push(Number(songID))

    let result
    try {
      result = await db.execute(sql, params)
    } catch (e) {
      // migration 未跑（songID 欄不存在）時降級為不帶 songID 寫入，不阻斷快速新增流程
      if (hasSongID && /Unknown column/i.test(e.message)) {
        console.warn('[ALIASES] songID 欄位不存在（migration 未執行），以未綁定模式寫入')
        songIDSupported = false
        result = await db.execute(
          `INSERT INTO aliases (aliasType, canonicalName, aliasValue, note)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE note = VALUES(note), updatedAt = CURRENT_TIMESTAMP(6)`,
          params.slice(0, 4)
        )
      } else {
        throw e
      }
    }

    // Fetch the created/updated record
    // ⚠️ 必須帶 songID 條件：新 UNIQUE 下同 (type, canonical, value) 可能有多筆，
    //    只比前三欄會隨機拿到綁別首歌的那一筆（回給前端就成了錯誤的 aliasID）。
    //    未帶 songID（含所有 artist 別名）＝ songID IS NULL 的那一筆（songKey 0）。
    const fetchSql = `
      SELECT ${ALIAS_COLUMNS}
      FROM aliases
      WHERE aliasType = ? AND canonicalName = ? AND aliasValue = ?
      ${songIDSupported ? (hasSongID ? 'AND songID = ?' : 'AND songID IS NULL') : ''}
    `

    const fetchParams = [aliasType, canonicalName.trim(), aliasValue.trim()]
    if (songIDSupported && hasSongID) fetchParams.push(targetSongID)

    const [createdAlias] = await db.query(fetchSql, fetchParams)

    // isNew：以「這個 songID 組合」預查時在不在為準（songID 欄不可用時退回 affectedRows）
    const isNew = songIDSupported
      ? !siblings.some((r) => (r.songID ?? null) === targetSongID)
      : result.meta.changes === 1

    // 同寫法但綁在其他歌曲上的別名（同名異曲各自綁定，彼此不再互搶）——只做告知
    const alsoBoundTo = songIDSupported
      ? [...new Set(
          siblings
            .map((r) => r.songID)
            .filter((id) => id != null && id !== targetSongID)
        )]
      : []

    return c.json(
      {
        success: true,
        data: createdAlias,
        isNew,
        ...(alsoBoundTo.length > 0 ? { alsoBoundTo } : {})
      },
      isNew ? 201 : 200
    )
  } catch (error) {
    console.error('POST /aliases/quick-add error:', error)
    return c.json(
      {
        success: false,
        error: {
          message: 'Failed to add alias'
        }
      },
      500
    )
  }
})

/**
 * POST /aliases/test
 * Test alias matching for a given input
 * @body {aliasType, inputText}
 * @returns {Object} Matching results
 */
app.post('/test', async (c) => {
  const db = c.get('db')

  try {
    const body = await c.req.json()
    const { aliasType, inputText } = body

    // Validation
    if (!aliasType || !['artist', 'title'].includes(aliasType)) {
      return c.json(
        {
          success: false,
          error: {
            message: 'Invalid aliasType',
            details: 'aliasType must be "artist" or "title"'
          }
        },
        400
      )
    }

    if (!inputText) {
      return c.json(
        {
          success: false,
          error: {
            message: 'Missing inputText',
            details: 'inputText is required'
          }
        },
        400
      )
    }

    // Find matching aliases
    const sql = `
      SELECT
        canonicalName,
        aliasValue,
        note
      FROM aliases
      WHERE aliasType = ? AND (
        canonicalName LIKE ? OR
        aliasValue LIKE ?
      )
      ORDER BY
        CASE
          WHEN canonicalName = ? THEN 1
          WHEN aliasValue = ? THEN 2
          WHEN canonicalName LIKE ? THEN 3
          ELSE 4
        END,
        canonicalName
    `

    const searchPattern = `%${inputText.trim()}%`
    const matches = await db.query(sql, [
      aliasType,
      searchPattern,
      searchPattern,
      inputText.trim(),
      inputText.trim(),
      `${inputText.trim()}%`
    ])

    // Group by canonical name
    // 新 UNIQUE 含 songKey ⇒ 同一組 (type, canonical, value) 可綁不同 songID 並存多筆。
    // 這裡是「輸入這串字會對到哪些正式名稱」的展示、不看 songID，同值同備註的重複列
    // 在畫面上是純噪音（兩筆長得一模一樣）⇒ 去重，matchCount 也算去重後的數量
    const grouped = {}
    const seen = new Set()
    let matchCount = 0
    for (const match of matches) {
      // JSON 序列化當 key：別名值可能含分隔字元，字串相接會讓不同組合撞在一起
      const dedupeKey = JSON.stringify([match.canonicalName, match.aliasValue, match.note ?? ''])
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      matchCount++

      if (!grouped[match.canonicalName]) {
        grouped[match.canonicalName] = {
          canonicalName: match.canonicalName,
          aliases: []
        }
      }
      grouped[match.canonicalName].aliases.push({
        value: match.aliasValue,
        note: match.note
      })
    }

    return c.json({
      success: true,
      data: {
        inputText: inputText.trim(),
        aliasType,
        matches: Object.values(grouped),
        matchCount
      }
    })
  } catch (error) {
    console.error('POST /aliases/test error:', error)
    return c.json(
      {
        success: false,
        error: {
          message: 'Failed to test alias'
        }
      },
      500
    )
  }
})

/**
 * POST /aliases/batch
 * Batch add aliases
 * @body {aliases: Array<{aliasType, canonicalName, aliasValue, note?}>}
 * @returns {Object} Batch insert results
 */
app.post('/batch', async (c) => {
  const db = c.get('db')

  try {
    const body = await c.req.json()
    const { aliases } = body

    if (Array.isArray(aliases) && aliases.length > 100) {
      return c.json({ success: false, error: { message: 'Maximum 100 items per batch' } }, 400)
    }
    if (!Array.isArray(aliases) || aliases.length === 0) {
      return c.json(
        {
          success: false,
          error: {
            message: 'Invalid input',
            details: 'aliases must be a non-empty array'
          }
        },
        400
      )
    }

    // Validate all records
    for (let i = 0; i < aliases.length; i++) {
      const alias = aliases[i]
      if (
        !alias.aliasType ||
        !['artist', 'title'].includes(alias.aliasType)
      ) {
        return c.json(
          {
            success: false,
            error: {
              message: `Invalid aliasType at index ${i}`,
              details: 'aliasType must be "artist" or "title"'
            }
          },
          400
        )
      }
      if (!alias.canonicalName || !alias.aliasValue) {
        return c.json(
          {
            success: false,
            error: {
              message: `Missing required fields at index ${i}`,
              details: 'canonicalName and aliasValue are required'
            }
          },
          400
        )
      }
      const lengthError = validateLengths(alias, ALIAS_FIELD_LIMITS)
      if (lengthError) {
        return c.json(
          {
            success: false,
            error: {
              message: `Invalid input at index ${i}`,
              details: lengthError
            }
          },
          400
        )
      }
    }

    // Batch insert with transaction
    await db.execute('START TRANSACTION')

    // batch 不支援 songID ⇒ 寫入的恆為 songID NULL（songKey 0）那一列。
    // 新 UNIQUE (aliasType, canonicalName, aliasValue, songKey) 下，ON DUPLICATE 只會撞到
    // 同樣未綁定的那一筆——同寫法但已綁 songID 的別名各自獨立、不會被這裡覆蓋。
    const sql = `
      INSERT INTO aliases (aliasType, canonicalName, aliasValue, note)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        note = VALUES(note),
        updatedAt = CURRENT_TIMESTAMP(6)
    `

    let inserted = 0
    let updated = 0
    const errors = []

    for (let i = 0; i < aliases.length; i++) {
      const alias = aliases[i]
      try {
        const result = await db.execute(sql, [
          alias.aliasType,
          alias.canonicalName.trim(),
          alias.aliasValue.trim(),
          alias.note || null
        ])

        if (result.meta.changes === 1) {
          inserted++
        } else if (result.meta.changes === 2) {
          updated++
        }
      } catch (error) {
        // 逐筆失敗的實際原因只進 log（前端僅使用 errors.length）
        console.error(`POST /aliases/batch item ${i} failed:`, error)
        errors.push({
          index: i,
          alias,
          error: 'Insert failed'
        })
      }
    }

    await db.execute('COMMIT')

    return c.json({
      success: true,
      data: {
        total: aliases.length,
        inserted,
        updated,
        errors: errors.length > 0 ? errors : undefined
      }
    })
  } catch (error) {
    console.error('POST /aliases/batch error:', error)
    await db.execute('ROLLBACK')
    return c.json(
      {
        success: false,
        error: {
          message: 'Batch insert failed'
        }
      },
      500
    )
  }
})

/**
 * PUT /aliases/:aliasID
 * Update a single alias
 * @param {number} aliasID - Alias ID
 * @body {canonicalName?, aliasValue?, note?}
 * @returns {Object} Updated alias record
 */
app.put('/:aliasID', async (c) => {
  const db = c.get('db')
  const aliasID = parseInt(c.req.param('aliasID'))

  if (!aliasID || aliasID < 1) {
    return c.json(
      {
        success: false,
        error: {
          message: 'Invalid aliasID',
          details: 'aliasID must be a positive integer'
        }
      },
      400
    )
  }

  try {
    const body = await c.req.json()
    const { canonicalName, aliasValue, note, songID } = body

    // Check if alias exists
    const checkSql = `SELECT ${ALIAS_COLUMNS} FROM aliases WHERE aliasID = ?`
    const [existingAlias] = await db.query(checkSql, [aliasID])

    if (!existingAlias) {
      return c.json(
        {
          success: false,
          error: {
            message: 'Alias not found',
            details: `aliasID ${aliasID} does not exist`
          }
        },
        404
      )
    }

    const lengthError = validateLengths(body, ALIAS_FIELD_LIMITS)
    if (lengthError) {
      return c.json(
        {
          success: false,
          error: {
            message: 'Invalid input',
            details: lengthError
          }
        },
        400
      )
    }

    // Build update query dynamically
    const updates = []
    const params = []

    // null / 非字串值會讓 .trim() 拋 TypeError → 500，先驗證
    if (canonicalName !== undefined) {
      if (typeof canonicalName !== 'string' || !canonicalName.trim()) {
        return c.json({ success: false, error: { message: 'Invalid canonicalName', details: 'canonicalName must be a non-empty string' } }, 400)
      }
      updates.push('canonicalName = ?')
      params.push(canonicalName.trim())
    }
    if (aliasValue !== undefined) {
      if (typeof aliasValue !== 'string' || !aliasValue.trim()) {
        return c.json({ success: false, error: { message: 'Invalid aliasValue', details: 'aliasValue must be a non-empty string' } }, 400)
      }
      updates.push('aliasValue = ?')
      params.push(aliasValue.trim())
    }
    if (note !== undefined) {
      updates.push('note = ?')
      params.push(note || null)
    }
    // songID 綁定（title alias 專用）：null/空字串 = 解除綁定；需先跑 migration 加欄位
    if (songID !== undefined) {
      const sid = (songID === null || songID === '') ? null : Number(songID)
      if (sid !== null && (!Number.isInteger(sid) || sid < 1)) {
        return c.json({ success: false, error: { message: 'Invalid songID', details: 'songID must be a positive integer or null' } }, 400)
      }
      updates.push('songID = ?')
      params.push(sid)
    }

    if (updates.length === 0) {
      return c.json({ success: true, data: existingAlias }, 200)
    }

    updates.push('updatedAt = CURRENT_TIMESTAMP(6)')
    params.push(aliasID)

    const sql = `UPDATE aliases SET ${updates.join(', ')} WHERE aliasID = ?`
    await db.execute(sql, params)

    // Fetch updated record
    const [updatedAlias] = await db.query(checkSql, [aliasID])

    return c.json({
      success: true,
      data: updatedAlias
    })
  } catch (error) {
    console.error(`PUT /aliases/${aliasID} error:`, error)
    // UNIQUE 是 (aliasType, canonicalName, aliasValue, songKey)：改綁 songID／改寫別名值
    // 時可能撞到「同寫法已綁在那首歌上」的既有列。這是使用者可理解的衝突，不是 500。
    if (error.code === 'ER_DUP_ENTRY') {
      return c.json(
        {
          success: false,
          error: {
            message: 'Duplicate alias',
            details: 'An alias with the same type, canonical name, value and song binding already exists'
          }
        },
        409
      )
    }
    return c.json(
      {
        success: false,
        error: {
          message: 'Failed to update alias'
        }
      },
      500
    )
  }
})

/**
 * DELETE /aliases/:aliasID
 * Delete a single alias
 * @param {number} aliasID - Alias ID
 * @returns {Object} Deletion result
 */
app.delete('/:aliasID', async (c) => {
  const db = c.get('db')
  const aliasID = parseInt(c.req.param('aliasID'))

  if (!aliasID || aliasID < 1) {
    return c.json(
      {
        success: false,
        error: {
          message: 'Invalid aliasID',
          details: 'aliasID must be a positive integer'
        }
      },
      400
    )
  }

  try {
    // Check if alias exists
    const checkSql = `SELECT ${ALIAS_COLUMNS} FROM aliases WHERE aliasID = ?`
    const [existingAlias] = await db.query(checkSql, [aliasID])

    if (!existingAlias) {
      return c.json(
        {
          success: false,
          error: {
            message: 'Alias not found',
            details: `aliasID ${aliasID} does not exist`
          }
        },
        404
      )
    }

    // Delete alias
    const deleteSql = 'DELETE FROM aliases WHERE aliasID = ?'
    await db.execute(deleteSql, [aliasID])

    return c.json({
      success: true,
      data: {
        deletedAlias: existingAlias,
        message: 'Alias deleted successfully'
      }
    })
  } catch (error) {
    console.error(`DELETE /aliases/${aliasID} error:`, error)
    return c.json(
      {
        success: false,
        error: {
          message: 'Failed to delete alias'
        }
      },
      500
    )
  }
})

export default app
