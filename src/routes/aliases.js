/**
 * @fileoverview Aliases management API routes
 * @description Provides CRUD operations for artist and title aliases
 * @features No caching, real-time database queries, direct error throwing
 */

import { Hono } from 'hono'

const app = new Hono()

/**
 * GET /aliases
 * Get all aliases (flat list for Tabulator)
 * @returns {Array} Array of alias records
 */
app.get('/', async (c) => {
  const db = c.get('db')

  try {
    const sql = `
      SELECT
        aliasID,
        aliasType,
        canonicalName,
        aliasValue,
        note,
        createdAt,
        updatedAt
      FROM aliases
      ORDER BY aliasType, canonicalName, aliasValue
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
          message: 'Failed to fetch aliases',
          details: error.message
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
    const sql = `
      SELECT
        aliasType,
        canonicalName,
        aliasValue
      FROM aliases
      ORDER BY aliasType, canonicalName
    `

    const aliases = await db.query(sql)

    // Group aliases by type and canonical name
    const grouped = {
      artistAliases: {},
      titleAliases: {}
    }

    for (const alias of aliases) {
      const targetMap =
        alias.aliasType === 'artist'
          ? grouped.artistAliases
          : grouped.titleAliases

      if (!targetMap[alias.canonicalName]) {
        targetMap[alias.canonicalName] = []
      }

      targetMap[alias.canonicalName].push(alias.aliasValue)
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
          message: 'Aliases API unavailable',
          details: error.message
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
    const { aliasType, canonicalName, aliasValue, note } = body

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

    // Insert alias
    const sql = `
      INSERT INTO aliases (aliasType, canonicalName, aliasValue, note)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        note = VALUES(note),
        updatedAt = CURRENT_TIMESTAMP(6)
    `

    const result = await db.execute(sql, [
      aliasType,
      canonicalName.trim(),
      aliasValue.trim(),
      note || null
    ])

    // Fetch the created/updated record
    const fetchSql = `
      SELECT * FROM aliases
      WHERE aliasType = ? AND canonicalName = ? AND aliasValue = ?
    `

    const [createdAlias] = await db.query(fetchSql, [
      aliasType,
      canonicalName.trim(),
      aliasValue.trim()
    ])

    return c.json(
      {
        success: true,
        data: createdAlias,
        isNew: result.meta.changes === 1
      },
      result.meta.changes === 1 ? 201 : 200
    )
  } catch (error) {
    console.error('POST /aliases/quick-add error:', error)
    return c.json(
      {
        success: false,
        error: {
          message: 'Failed to add alias',
          details: error.message
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
    const grouped = {}
    for (const match of matches) {
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
        matchCount: matches.length
      }
    })
  } catch (error) {
    console.error('POST /aliases/test error:', error)
    return c.json(
      {
        success: false,
        error: {
          message: 'Failed to test alias',
          details: error.message
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
    }

    // Batch insert with transaction
    await db.execute('START TRANSACTION')

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
        errors.push({
          index: i,
          alias,
          error: error.message
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
          message: 'Batch insert failed',
          details: error.message
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
    const { canonicalName, aliasValue, note } = body

    // Check if alias exists
    const checkSql = 'SELECT * FROM aliases WHERE aliasID = ?'
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

    // Build update query dynamically
    const updates = []
    const params = []

    if (canonicalName !== undefined) {
      updates.push('canonicalName = ?')
      params.push(canonicalName.trim())
    }
    if (aliasValue !== undefined) {
      updates.push('aliasValue = ?')
      params.push(aliasValue.trim())
    }
    if (note !== undefined) {
      updates.push('note = ?')
      params.push(note || null)
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
    return c.json(
      {
        success: false,
        error: {
          message: 'Failed to update alias',
          details: error.message
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
    const checkSql = 'SELECT * FROM aliases WHERE aliasID = ?'
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
          message: 'Failed to delete alias',
          details: error.message
        }
      },
      500
    )
  }
})

export default app
