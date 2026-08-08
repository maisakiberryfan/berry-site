import {
  validateRequired,
  validateLength,
  FIELD_LIMITS,
  successResponse,
  mysqlToISO8601,
} from "../utils/middleware.js";
import { createErrorResponse } from "../utils/database.js";
import { checkETagMatch, CACHE_CONFIG, ETAG_VERSION, generateMetaETag } from "../utils/cache.js";

// setlist VIEW = setlist_ori JOIN songlist JOIN streamlist：
// 三表任一變更都會反映在各自的 updatedAt / COUNT（FK 為 ON DELETE RESTRICT，
// 刪除必先動引用 row；UPDATE CASCADE 情境由來源表自身 updatedAt 捕捉）
async function getSetlistMeta(db) {
  // cols：setlist VIEW 的欄位清單——VIEW 定義由 DB 端管理（repo 無 migration），
  // ALTER VIEW 增減欄位時自動反映在 ETag，不依賴人工 bump ETAG_VERSION
  //（欄位不變、格式變的情形仍需 bump）
  return db.first(`SELECT
    (SELECT COUNT(*) FROM setlist_ori) AS c1, (SELECT MAX(updatedAt) FROM setlist_ori) AS m1,
    (SELECT COUNT(*) FROM streamlist)  AS c2, (SELECT MAX(updatedAt) FROM streamlist)  AS m2,
    (SELECT COUNT(*) FROM songlist)    AS c3, (SELECT MAX(updatedAt) FROM songlist)    AS m3,
    (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION)
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'setlist') AS cols`);
}

// 'YYYY-MM' → 'YYYY-MM-01'；無效格式回 null
function monthStart(ym) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(ym) ? `${ym}-01` : null;
}

// 'YYYY-MM' 的次月首日（exclusive 上界）。年份 padStart 防前導零遺失被 MariaDB
// 依二位年規則重詮釋（'69-01-01'→2069）；9999-12 clamp 在 DATETIME 值域內
function nextMonthStart(ym) {
  const y = parseInt(ym.slice(0, 4), 10);
  const m = parseInt(ym.slice(5, 7), 10);
  if (y >= 9999 && m === 12) return "9999-12-31 23:59:59.999999";
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

// GET /setlist - Get all setlist entries with song details
// 支援：?streamID=（單場）、?from=YYYY-MM&to=YYYY-MM（月度區段，配合 manifest 增量更新）、
// 無參數（全量，meta ETag 304 短路）
export async function getSetlist(c) {
  try {
    const db = c.get("db");
    const streamID = c.req.query("streamID");  // Optional filter parameter
    const from = c.req.query("from");
    const to = c.req.query("to");
    const ifNoneMatch = c.req.header('If-None-Match');

    // 單場查詢（viewSetlist modal / 解析流程用）：行為不變
    if (streamID) {
      const setlist = await db.query(`
        SELECT *
        FROM setlist
        WHERE streamID = ?
        ORDER BY segmentNo ASC, trackNo ASC
      `, [streamID]);
      return c.json(successResponse(setlist.map((entry) => ({
        ...entry,
        time: mysqlToISO8601(entry.time),
      }))));
    }

    // 月度區段（from/to 皆含）：前端由 manifest 判斷抓哪些月，此端點不做 ETag。
    // 特殊值 none：不留檔場（streamID 為佔位符、無對應 stream、VIEW time 為 NULL）bucket
    if (from || to) {
      if (from === "none" || to === "none") {
        const rows = await db.query(`
          SELECT *
          FROM setlist
          WHERE time IS NULL
          ORDER BY segmentNo ASC, trackNo ASC, streamID ASC
        `);
        return c.json(successResponse(rows), 200, {
          'Cache-Control': CACHE_CONFIG.HEADERS.CACHEABLE
        });
      }
      const lower = monthStart(from || "1970-01");
      const upper = to ? (monthStart(to) && nextMonthStart(to)) : "9999-01-01";
      if (!lower || !upper) {
        return c.json(createErrorResponse("VALIDATION_ERROR", "from/to must be YYYY-MM"), 400);
      }
      const rows = await db.query(`
        SELECT *
        FROM setlist
        WHERE time >= ? AND time < ?
        ORDER BY time DESC, segmentNo ASC, trackNo ASC
      `, [lower, upper]);
      return c.json(successResponse(rows.map((entry) => ({
        ...entry,
        time: mysqlToISO8601(entry.time),
      }))), 200, {
        'Cache-Control': CACHE_CONFIG.HEADERS.CACHEABLE
      });
    }

    // 全量：先以輕量 meta 查詢生成 ETag，304 路徑完全免查 15k+ 筆
    const meta = await getSetlistMeta(db);
    const etag = generateMetaETag(ETAG_VERSION.setlist, meta);
    if (checkETagMatch(ifNoneMatch, etag)) {
      return c.body(null, 304, {
        'ETag': etag,
        'Cache-Control': CACHE_CONFIG.HEADERS.NOT_MODIFIED
      });
    }

    const setlist = await db.query(`
      SELECT *
      FROM setlist
      ORDER BY time DESC, segmentNo ASC, trackNo ASC
    `);
    const formattedSetlist = setlist.map((entry) => ({
      ...entry,
      time: mysqlToISO8601(entry.time),
    }));

    return c.json(successResponse(formattedSetlist), 200, {
      'ETag': etag,
      'Cache-Control': CACHE_CONFIG.HEADERS.CACHEABLE
    });
  } catch (error) {
    console.error("Get setlist failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", "Database operation failed"), 500);
  }
}

// GET /setlist/manifest - 每月 {month, count, maxUpdated} 清單（前端月度增量更新的比對依據）
// per-month 指紋含三表 updatedAt 的 GREATEST：歌名修正、直播時間修改、歌單編輯
// 都會讓「受影響月份」的指紋前進，前端只重抓那些月。
// ETag 與全量端點共用同一組 meta——manifest 304 = 整個資料集沒變。
export async function getSetlistManifest(c) {
  try {
    const db = c.get("db");
    const ifNoneMatch = c.req.header('If-None-Match');

    const meta = await getSetlistMeta(db);
    const etag = generateMetaETag(ETAG_VERSION.setlist, meta);
    if (checkETagMatch(ifNoneMatch, etag)) {
      return c.body(null, 304, {
        'ETag': etag,
        'Cache-Control': CACHE_CONFIG.HEADERS.NOT_MODIFIED
      });
    }

    // LEFT JOIN streamlist：不留檔場（佔位 streamID 無對應 stream）歸入 month='none'
    // bucket，否則月度增量會漏掉這批 rows（全量 VIEW 為 LEFT JOIN、含它們）。
    // 排序讓 none 殿後，前端「最近 N 月」邏輯拿到的都是真月份。
    const months = await db.query(`
      SELECT COALESCE(DATE_FORMAT(s.time, '%Y-%m'), 'none') AS month, COUNT(*) AS count,
             MAX(GREATEST(COALESCE(o.updatedAt, '1970-01-01'), COALESCE(s.updatedAt, '1970-01-01'), COALESCE(g.updatedAt, '1970-01-01'))) AS maxUpdated
      FROM setlist_ori o
      LEFT JOIN streamlist s ON o.streamID = s.streamID
      LEFT JOIN songlist g ON o.songID = g.songID
      GROUP BY month
      ORDER BY (month = 'none') ASC, month DESC
    `);

    // version 隨 ETAG_VERSION bump：前端把它摻進 per-month 指紋，
    // 版本升級（輸出格式變更）時所有月份視為變更、觸發全量重抓
    return c.json(successResponse({ version: ETAG_VERSION.setlist, months }), 200, {
      'ETag': etag,
      'Cache-Control': CACHE_CONFIG.HEADERS.CACHEABLE
    });
  } catch (error) {
    console.error("Get setlist manifest failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", "Database operation failed"), 500);
  }
}

// POST /setlist - Create setlist entry (supports both single and batch)
export async function createSetlistEntry(c) {
  const db = c.get("db");
  const body = await c.req.json();

  // Auto-detect format: object for single, array for batch
  const isBatch = Array.isArray(body);
  const entries = isBatch ? body : [body];

  // Validate batch input
  if (isBatch && entries.length > 200) {
    return c.json(createErrorResponse("VALIDATION_ERROR", "Maximum 200 items per batch"), 400);
  }
  if (isBatch && entries.length === 0) {
    return c.json(
      createErrorResponse(
        "VALIDATION_ERROR",
        "Request body must be a non-empty array",
      ),
      400,
    );
  }

  try {
    await db.execute("START TRANSACTION");

    // Pre-collect unique IDs for batch validation (performance optimization)
    const uniqueStreamIDs = new Set();
    const uniqueSongIDs = new Set();

    for (const entry of entries) {
      const requiredFields = ["streamID", "trackNo"];
      const fieldErrors = validateRequired(entry, requiredFields);

      if (fieldErrors) {
        await db.execute("ROLLBACK");
        const errorMsg = isBatch
          ? "Required fields missing in batch item"
          : "Required fields missing";
        return c.json(
          createErrorResponse("VALIDATION_ERROR", errorMsg, fieldErrors),
          400,
        );
      }

      // note is a TEXT column and a batch carries up to 200 of them, so cap each one
      const noteError = validateLength(entry.note, "note", FIELD_LIMITS.setlistNote);
      if (noteError) {
        await db.execute("ROLLBACK");
        return c.json(createErrorResponse("VALIDATION_ERROR", noteError), 400);
      }

      uniqueStreamIDs.add(entry.streamID);
      if (entry.songID) {
        uniqueSongIDs.add(Number(entry.songID)); // Convert to number for consistent type checking
      }
    }

    // Batch validate streamIDs (1 query instead of N)
    if (uniqueStreamIDs.size > 0) {
      const streamIDList = Array.from(uniqueStreamIDs)
        .map(() => "?")
        .join(",");
      const existingStreams = await db.query(
        `SELECT streamID FROM streamlist WHERE streamID IN (${streamIDList})`,
        Array.from(uniqueStreamIDs),
      );
      const existingStreamSet = new Set(
        existingStreams.map((s) => s.streamID),
      );

      for (const streamID of uniqueStreamIDs) {
        if (!existingStreamSet.has(streamID)) {
          await db.execute("ROLLBACK");
          return c.json(
            createErrorResponse("NOT_FOUND", `Stream not found: ${streamID}`),
            404,
          );
        }
      }
    }

    // Batch validate songIDs (1 query instead of M)
    if (uniqueSongIDs.size > 0) {
      const songIDArray = Array.from(uniqueSongIDs);
      const songIDList = songIDArray.map(() => "?").join(",");

      const existingSongs = await db.query(
        `SELECT songID FROM songlist WHERE songID IN (${songIDList})`,
        songIDArray,
      );

      const existingSongSet = new Set(existingSongs.map((s) => s.songID));

      for (const songID of uniqueSongIDs) {
        if (!existingSongSet.has(songID)) {
          await db.execute("ROLLBACK");
          return c.json(
            createErrorResponse("NOT_FOUND", `Song not found: ${songID}`),
            404,
          );
        }
      }
    }

    // Check request source to determine UPSERT behavior
    // User-initiated requests should overwrite existing data
    // Worker auto-updates should protect user manual corrections
    const isUserRequest = c.req.header("X-Source") === "user";

    // Process entries (validation already done)
    // Use batch INSERT for better performance
    const placeholders = entries
      .map(() => "(?, ?, ?, ?, ?)")
      .join(", ");
    const values = entries.flatMap((entry) => {
      const { streamID, trackNo, segmentNo = 1, songID, note } = entry;
      return [streamID, trackNo, segmentNo, songID || null, note || null];
    });

    // Batch UPSERT with conditional update logic
    if (isUserRequest) {
      // User edit: Always overwrite (direct update)
      await db.execute(
        `INSERT INTO setlist_ori (streamID, trackNo, segmentNo, songID, note)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           segmentNo = VALUES(segmentNo),
           songID = VALUES(songID),
           note = VALUES(note)`,
        values,
      );
    } else {
      // Worker auto-update: Protect existing user edits
      // Only update if original is NULL/empty (conservative merge)
      await db.execute(
        `INSERT INTO setlist_ori (streamID, trackNo, segmentNo, songID, note)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           segmentNo = VALUES(segmentNo),
           songID = IF(songID IS NULL, VALUES(songID), songID),
           note = IF(note IS NULL OR note = '', VALUES(note), note)`,
        values,
      );
    }

    // Batch fetch results for response (composite key 含 segmentNo，缺了會撈到其他 segment 的 rows)
    const conditions = entries
      .map(() => "(streamID = ? AND segmentNo = ? AND trackNo = ?)")
      .join(" OR ");
    const fetchParams = entries.flatMap((entry) => [
      entry.streamID,
      entry.segmentNo ?? 1,
      entry.trackNo,
    ]);

    const results = await db.query(
      `SELECT * FROM setlist_ori WHERE ${conditions}`,
      fetchParams,
    );

    await db.execute("COMMIT");

    // Return appropriate response format
    if (isBatch) {
      return c.json(
        successResponse({
          message: `Successfully created ${results.length} setlist entries`,
          entries: results,
        }),
        201,
      );
    } else {
      return c.json(successResponse(results[0]), 201);
    }
  } catch (error) {
    await db.execute("ROLLBACK");
    console.error(`Setlist creation failed: ${error.message} (batch=${isBatch}, count=${entries.length})`);

    // Handle duplicate entry error (though ON DUPLICATE KEY UPDATE should prevent this)
    if (error.code === "ER_DUP_ENTRY" || error.message?.includes("Duplicate entry")) {
      return c.json(
        createErrorResponse("CONFLICT", "Setlist entry already exists"),
        409,
      );
    }

    return c.json(createErrorResponse("DATABASE_ERROR", "Database operation failed"), 500);
  }
}

// PUT /setlist/:streamID/:segmentNo/:trackNo - Update setlist entry
export async function updateSetlistEntry(c) {
  const db = c.get("db");
  const streamID = c.req.param("streamID");
  const segmentNo = parseInt(c.req.param("segmentNo"));
  const trackNo = parseInt(c.req.param("trackNo"));
  if (Number.isNaN(segmentNo) || Number.isNaN(trackNo)) {
    return c.json(createErrorResponse("VALIDATION_ERROR", "segmentNo and trackNo must be integers"), 400);
  }
  const body = await c.req.json();

  // Check if entry exists
  const existingEntry = await db.first(
    "SELECT * FROM setlist_ori WHERE streamID = ? AND segmentNo = ? AND trackNo = ?",
    [streamID, segmentNo, trackNo],
  );
  if (!existingEntry) {
    return c.json(
      createErrorResponse("NOT_FOUND", "Setlist entry not found"),
      404,
    );
  }

  const { songID, note, startTime, endTime } = body;

  const noteError = validateLength(note, "note", FIELD_LIMITS.setlistNote);
  if (noteError) {
    return c.json(createErrorResponse("VALIDATION_ERROR", noteError), 400);
  }

  // startTime/endTime: seconds into the video, editable via wiki UI (null = unknown)
  for (const [field, value] of [["startTime", startTime], ["endTime", endTime]]) {
    if (value !== undefined && value !== null) {
      if (!Number.isInteger(value) || value < 0 || value > 360000) {
        return c.json(
          createErrorResponse("VALIDATION_ERROR", `${field} must be null or an integer between 0 and 360000 (seconds)`, { [field]: "invalid" }),
          400,
        );
      }
    }
  }

  const updates = [];
  const params = [];

  if (songID !== undefined) {
    if (songID !== null) {
      // Validate songID exists if provided
      const songExists = await db.first(
        "SELECT 1 FROM songlist WHERE songID = ?",
        [songID],
      );
      if (!songExists) {
        return c.json(createErrorResponse("NOT_FOUND", "Song not found"), 404);
      }
    }
    updates.push("songID = ?");
    params.push(songID);
  }
  if (note !== undefined) {
    updates.push("note = ?");
    params.push(note);
  }
  if (startTime !== undefined) {
    updates.push("startTime = ?");
    params.push(startTime);
  }
  if (endTime !== undefined) {
    updates.push("endTime = ?");
    params.push(endTime);
  }

  if (updates.length === 0) {
    // Not an error — user may have clicked into a cell without changing it
    return c.json(
      successResponse(existingEntry),
      200,
    );
  }

  params.push(streamID, segmentNo, trackNo);

  try {
    await db.execute("START TRANSACTION");

    await db.execute(
      `UPDATE setlist_ori SET ${updates.join(", ")} WHERE streamID = ? AND segmentNo = ? AND trackNo = ?`,
      params,
    );

    await db.execute("COMMIT");
  } catch (error) {
    await db.execute("ROLLBACK");
    throw error;
  }

  // Return the updated formatted view entry - use original table due to collation issues
  const updatedEntry = await db.first(
    "SELECT * FROM setlist_ori WHERE streamID = ? AND segmentNo = ? AND trackNo = ?",
    [streamID, segmentNo, trackNo],
  );

  return c.json(successResponse(updatedEntry));
}

// DELETE /setlist/:streamID/:segmentNo/:trackNo - Delete setlist entry
export async function deleteSetlistEntry(c) {
  const db = c.get("db");
  const streamID = c.req.param("streamID");
  const segmentNo = parseInt(c.req.param("segmentNo"));
  const trackNo = parseInt(c.req.param("trackNo"));
  if (Number.isNaN(segmentNo) || Number.isNaN(trackNo)) {
    return c.json(createErrorResponse("VALIDATION_ERROR", "segmentNo and trackNo must be integers"), 400);
  }

  // Check if entry exists
  const existingEntry = await db.first(
    "SELECT * FROM setlist_ori WHERE streamID = ? AND segmentNo = ? AND trackNo = ?",
    [streamID, segmentNo, trackNo],
  );
  if (!existingEntry) {
    return c.json(
      createErrorResponse("NOT_FOUND", "Setlist entry not found"),
      404,
    );
  }

  try {
    await db.execute("START TRANSACTION");

    await db.execute(
      "DELETE FROM setlist_ori WHERE streamID = ? AND segmentNo = ? AND trackNo = ?",
      [streamID, segmentNo, trackNo],
    );

    await db.execute("COMMIT");
  } catch (error) {
    await db.execute("ROLLBACK");
    throw error;
  }

  return c.json(
    successResponse({ message: "Setlist entry deleted successfully" }),
  );
}
