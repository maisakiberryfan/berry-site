import {
  validateRequired,
  validateLength,
  FIELD_LIMITS,
  successResponse,
  mysqlToISO8601,
} from "../utils/middleware.js";
import { createErrorResponse } from "../utils/database.js";
import { checkETagMatch, CACHE_CONFIG, ETAG_VERSION, generateMetaETag } from "../utils/cache.js";

// ─── Composite key 的值域（POST 驗證與 reorder 演算法共用）───
// 一段最多幾列（reorder 的 order 陣列上限）
const REORDER_MAX_ROWS = 200;
// reorder 的暫存區起點：第一段把每一列搬到 100000+新順位（護欄保證新順位 ≤200），
// 第二段再整段減回。負數暫存區不可用——trackNo 是 int(10) unsigned。
// ⚠️ 這個常數同時是 **trackNo 的上界依據**：一旦有列的 trackNo ≥ 此值，
//    reorder 的碰撞防護會讓整段永久無法重排（400），故 POST 就先擋在 1..99999。
export const REORDER_TEMP_OFFSET = 100000;
const TRACKNO_MAX = REORDER_TEMP_OFFSET - 1;
// segmentNo 是 tinyint unsigned 級別的段落編號（1＝第一段歌枠，實務上個位數）
const SEGMENTNO_MAX = 255;

/**
 * ROLLBACK 不可掩蓋原始錯誤，也不可把 4xx 變成 500：
 * 連線已死時 rollback 一定拋錯（server 端其實已隱含 rollback），裸 await 會讓
 * 「驗證失敗→回 400」的路徑改拋例外、變成 500，真因也一併被換掉。
 */
async function safeRollback(db) {
  try {
    await db.execute("ROLLBACK");
  } catch (rollbackError) {
    console.error(`Setlist ROLLBACK failed (原始錯誤／驗證結果不受影響): ${rollbackError.message}`);
  }
}

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
        await safeRollback(db);
        const errorMsg = isBatch
          ? "Required fields missing in batch item"
          : "Required fields missing";
        return c.json(
          createErrorResponse("VALIDATION_ERROR", errorMsg, fieldErrors),
          400,
        );
      }

      // trackNo / segmentNo 是 PK 的一部分，先前完全沒驗型：非整數會被 MySQL 隱式轉型
      // 靜默寫進錯誤的 key（'abc' → 0、'3x' → 3、3.7 → 4 四捨五入），之後前端以
      // composite key 定位那一列就永遠對不上；trackNo 還必須低於 reorder 的暫存區起點，
      // 否則整段曲序修正會被碰撞防護永久擋住（見 REORDER_TEMP_OFFSET）。
      if (!Number.isInteger(entry.trackNo) || entry.trackNo < 1 || entry.trackNo > TRACKNO_MAX) {
        await safeRollback(db);
        return c.json(
          createErrorResponse(
            "VALIDATION_ERROR",
            `trackNo must be an integer between 1 and ${TRACKNO_MAX}`,
            { trackNo: "invalid" },
          ),
          400,
        );
      }
      // 未帶 segmentNo＝沿用預設 1（見下方 destructure）；帶了就必須是合法整數
      // （null 不算——它會讓 PK 欄位收到 NULL）
      if (entry.segmentNo !== undefined &&
        (!Number.isInteger(entry.segmentNo) || entry.segmentNo < 1 || entry.segmentNo > SEGMENTNO_MAX)) {
        await safeRollback(db);
        return c.json(
          createErrorResponse(
            "VALIDATION_ERROR",
            `segmentNo must be an integer between 1 and ${SEGMENTNO_MAX}`,
            { segmentNo: "invalid" },
          ),
          400,
        );
      }

      // note is a TEXT column and a batch carries up to 200 of them, so cap each one
      const noteError = validateLength(entry.note, "note", FIELD_LIMITS.setlistNote);
      if (noteError) {
        await safeRollback(db);
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
          await safeRollback(db);
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
          await safeRollback(db);
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

    // Batch UPSERT with conditional update logic
    if (isUserRequest) {
      // User edit: Always overwrite (direct update)
      for (const entry of entries) {
        for (const f of ["startTime", "endTime"]) {
          const v = entry[f];
          if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 0 || v > 360000)) {
            await safeRollback(db);
            return c.json(
              createErrorResponse("VALIDATION_ERROR", `${f} must be null or an integer between 0 and 360000 (seconds)`, { [f]: "invalid" }),
              400,
            );
          }
        }
      }
      const userPlaceholders = entries.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
      const userValues = entries.flatMap((entry) => {
        const { streamID, trackNo, segmentNo = 1, songID, note, startTime, endTime } = entry;
        return [streamID, trackNo, segmentNo, songID || null, note || null, startTime ?? null, endTime ?? null];
      });
      // ⚠️ **單筆與批次走的是同一條 UPSERT**（函式開頭 `entries = isBatch ? body : [body]`，
      // 陣列與物件只差在回應信封）⇒ 下面說的「全覆寫」對單筆 POST 一樣成立，
      // **呼叫端每次都必須帶齊 songID／note／startTime／endTime 四欄**。
      // 想只改一欄請用 `PUT /:streamID/:segmentNo/:trackNo`（只更新 body 有出現的欄位）——
      // 拿 POST 當「部分更新」用會把沒帶的三欄清成 NULL（含留言回補的時間戳）。
      //
      // 批次＝**所見即所得的整段狀態替換**（用戶裁示 2026-08-14）：
      // songID／note／startTime／endTime 全部無條件覆寫，payload 帶什麼就寫什麼，
      // 沒有「某些欄後端偷偷保留」的例外。note／startTime／endTime 帶 null＝真的清空；
      // songID 是 NOT NULL＋FK，沒有「清空」這個狀態，缺值會讓整批 INSERT 失敗並 rollback
      // （呼叫端應自行擋在送出前——v3 批次表單有每列必選曲的驗證）。
      //
      // 「批次撞既有列把 YouTube 留言回補的時間戳洗掉」這個風險**由前端承擔**：
      // v3 批次表單撞到既有 trackNo 時，會把既有的曲目／備註／時間戳 prefill 進欄位，
      // 使用者看得到、可改可留；要清空是明示的動作（把欄位清掉再送出）。
      // 後端用 COALESCE 偷偷保留反而讓「清空」在批次裡做不到，且與表單所見不符。
      //
      // 其他兩條路徑不受影響：
      //   PUT 單列——欄位有出現就照寫、null＝清空（timeEditor 的「清空」走這條），語意不變。
      //   worker 分支（下方 else）——自動更新沒有人在看表單，維持「只補空、不覆寫」。
      //
      // PK=(streamID, segmentNo, trackNo)（正式庫 SHOW CREATE TABLE 確認，2026-08-14）：
      // 撞列＝三元組全同，故 `segmentNo = VALUES(segmentNo)` 恆等值（無害死碼，留著
      // 防 PK 認知錯位）；segment 2 的批次不會撞到 segment 1 的同 trackNo。
      await db.execute(
        `INSERT INTO setlist_ori (streamID, trackNo, segmentNo, songID, note, startTime, endTime)
         VALUES ${userPlaceholders}
         ON DUPLICATE KEY UPDATE
           segmentNo = VALUES(segmentNo),
           songID = VALUES(songID),
           note = VALUES(note),
           startTime = VALUES(startTime),
           endTime = VALUES(endTime)`,
        userValues,
      );
    } else {
      // Worker auto-update: Protect existing user edits
      // Only update if original is NULL/empty (conservative merge)
      const placeholders = entries
        .map(() => "(?, ?, ?, ?, ?)")
        .join(", ");
      const values = entries.flatMap((entry) => {
        const { streamID, trackNo, segmentNo = 1, songID, note } = entry;
        return [streamID, trackNo, segmentNo, songID || null, note || null];
      });
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
    await safeRollback(db);
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
    // songID 是 NOT NULL＋FK：`songID: null` 沒有「清空」這個語意，寫下去只會在
    // DB 層炸成 1048（Column cannot be null）⇒ 500。明示回 400 才對得上真正的原因。
    if (songID === null) {
      return c.json(
        createErrorResponse("VALIDATION_ERROR", "songID cannot be null", { songID: "invalid" }),
        400,
      );
    }
    // Validate songID exists if provided
    const songExists = await db.first(
      "SELECT 1 FROM songlist WHERE songID = ?",
      [songID],
    );
    if (!songExists) {
      return c.json(createErrorResponse("NOT_FOUND", "Song not found"), 404);
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
    await safeRollback(db);
    throw error;
  }

  // Return the updated formatted view entry - use original table due to collation issues
  const updatedEntry = await db.first(
    "SELECT * FROM setlist_ori WHERE streamID = ? AND segmentNo = ? AND trackNo = ?",
    [streamID, segmentNo, trackNo],
  );

  return c.json(successResponse(updatedEntry));
}

// ─── Reorder（曲序修正）───
// trackNo 是 composite key 的一部分，「兩首對調」用單列 PUT 原理上做不到（必撞主鍵）。
// 本端點在單一 transaction 內以「高位偏移暫存區」兩段式重寫整段的 trackNo。
// REORDER_MAX_ROWS / REORDER_TEMP_OFFSET 定義在檔頭（與 POST 的 trackNo 值域共用）。

// PUT /setlist/:streamID/:segmentNo/reorder - 重排整個段落的曲序
// Body: { order: [3, 1, 2, ...] }（該段落現有 trackNo 的完整排列，
//        第 i 個元素＝新的第 i+1 順位要放原本的哪一首）
// ⚠️ 寫回後 trackNo 一律重編為 1..N 連續，原有空洞（1,2,5,7）會被正規化——
//    前端不可假設 trackNo 不變，請以回應帶回的整段列替換畫面。
export async function reorderSetlistSegment(c) {
  const db = c.get("db");
  const streamID = c.req.param("streamID");
  const segmentNo = parseInt(c.req.param("segmentNo"));
  if (Number.isNaN(segmentNo)) {
    return c.json(createErrorResponse("VALIDATION_ERROR", "segmentNo must be an integer"), 400);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json(createErrorResponse("VALIDATION_ERROR", "Request body must be valid JSON"), 400);
  }

  // ── 語法驗證（不需要碰 DB，先擋掉再開 transaction）──
  const order = body?.order;
  if (!Array.isArray(order) || order.length === 0) {
    return c.json(
      createErrorResponse("VALIDATION_ERROR", "order must be a non-empty array of integers",
        { order: "must be a non-empty array of integers" }),
      400,
    );
  }
  if (order.length > REORDER_MAX_ROWS) {
    return c.json(
      createErrorResponse("VALIDATION_ERROR", `order must contain at most ${REORDER_MAX_ROWS} items`,
        { order: `at most ${REORDER_MAX_ROWS} items` }),
      400,
    );
  }
  if (!order.every((n) => Number.isInteger(n))) {
    return c.json(
      createErrorResponse("VALIDATION_ERROR", "order must contain integers only",
        { order: "all items must be integers" }),
      400,
    );
  }
  if (new Set(order).size !== order.length) {
    return c.json(
      createErrorResponse("VALIDATION_ERROR", "order must not contain duplicate trackNo values",
        { order: "duplicate trackNo" }),
      400,
    );
  }

  try {
    // transaction 全程走同一條連線：Lambda 是模組級單一 cachedConnection（單容器一次
    // 只處理一個請求），CF/Hyperdrive 是 per-instance 連線（Database 實例 per-request 建立）——
    // 兩條路徑都不是連線池 fan-out，START/COMMIT/ROLLBACK 語意成立（同 createSetlistEntry）。
    await db.execute("START TRANSACTION");

    // FOR UPDATE 鎖住整段：驗證與重寫之間別人插不進來（併發下第二者會等鎖，
    // 拿到鎖時讀到新集合 → 集合比對失敗 → 400，不會蓋掉對方剛加的列）
    const existing = await db.query(
      "SELECT trackNo FROM setlist_ori WHERE streamID = ? AND segmentNo = ? ORDER BY trackNo ASC FOR UPDATE",
      [streamID, segmentNo],
    );

    if (existing.length === 0) {
      await safeRollback(db);
      return c.json(createErrorResponse("NOT_FOUND", "Setlist segment not found"), 404);
    }

    const current = existing.map((row) => Number(row.trackNo));

    // 暫存區碰撞防護：正常資料 trackNo 遠小於 100000，真出現就拒絕而不是靜默覆寫
    if (current.some((t) => t >= REORDER_TEMP_OFFSET)) {
      await safeRollback(db);
      return c.json(
        createErrorResponse("VALIDATION_ERROR",
          `Segment contains trackNo >= ${REORDER_TEMP_OFFSET}, cannot reorder safely`,
          { order: "segment out of supported range" }),
        400,
      );
    }

    // 集合必須完全一致（無缺、無多、無重複——重複已於前面擋掉）
    const currentSet = new Set(current);
    const orderSet = new Set(order);
    const missing = current.filter((t) => !orderSet.has(t));
    const unknown = order.filter((t) => !currentSet.has(t));
    if (missing.length > 0 || unknown.length > 0) {
      await safeRollback(db);
      return c.json(
        createErrorResponse("VALIDATION_ERROR",
          "order must be a permutation of the segment's existing trackNo values",
          {
            order: `missing: [${missing.join(", ")}], unknown: [${unknown.join(", ")}]`,
          }),
        400,
      );
    }

    // 第一段：逐列搬進暫存區（新順位 i+1 → 100000+i+1），避開與現值的主鍵衝突
    for (let i = 0; i < order.length; i++) {
      const result = await db.execute(
        "UPDATE setlist_ori SET trackNo = ? WHERE streamID = ? AND segmentNo = ? AND trackNo = ?",
        [REORDER_TEMP_OFFSET + i + 1, streamID, segmentNo, order[i]],
      );
      // FOR UPDATE 之後理應恆為 1；不是就代表狀態與剛才讀到的不一致，整批放棄
      if (result?.meta?.changes !== 1) {
        await safeRollback(db);
        return c.json(
          createErrorResponse("CONFLICT", "Segment changed during reorder, please reload"),
          409,
        );
      }
    }

    // 第二段：單語句整段減回，trackNo 落在 1..N 連續
    await db.execute(
      "UPDATE setlist_ori SET trackNo = trackNo - ? WHERE streamID = ? AND segmentNo = ? AND trackNo >= ?",
      [REORDER_TEMP_OFFSET, streamID, segmentNo, REORDER_TEMP_OFFSET],
    );

    await db.execute("COMMIT");
  } catch (error) {
    // ROLLBACK 自身再拋錯不可掩蓋原始錯誤（原錯才是 onError 要分類的那個）——
    // safeRollback 內部已 try/catch（連線已死時 rollback 由 server 端隱含完成）
    await safeRollback(db);
    console.error(`Setlist reorder failed: ${error.message} (streamID=${streamID}, segmentNo=${segmentNo}, count=${order.length})`);
    throw error;
  }

  // 回應整段重排後的完整列（與 GET /setlist?streamID= 同格式與 formatter），
  // 讓前端直接整段替換
  const rows = await db.query(
    "SELECT * FROM setlist WHERE streamID = ? AND segmentNo = ? ORDER BY trackNo ASC",
    [streamID, segmentNo],
  );

  return c.json(successResponse(rows.map((entry) => ({
    ...entry,
    time: mysqlToISO8601(entry.time),
  }))));
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
    await safeRollback(db);
    throw error;
  }

  return c.json(
    successResponse({ message: "Setlist entry deleted successfully" }),
  );
}
