import {
  validateRequired,
  successResponse,
  mysqlToISO8601,
} from "../utils/middleware.js";
import { createErrorResponse } from "../utils/database.js";
import { generateETag, checkETagMatch, CACHE_CONFIG } from "../utils/cache.js";

// GET /setlist - Get all setlist entries with song details (supports filtering, no KV cache, ETag only)
export async function getSetlist(c) {
  try {
    const db = c.get("db");
    const streamID = c.req.query("streamID");  // Optional filter parameter
    const ifNoneMatch = c.req.header('If-None-Match');

    // Always fetch from database
    let setlist;
    if (streamID) {
      setlist = await db.query(`
        SELECT *
        FROM setlist
        WHERE streamID = ?
        ORDER BY segmentNo ASC, trackNo ASC
      `, [streamID]);
    } else {
      setlist = await db.query(`
        SELECT *
        FROM setlist
        ORDER BY time DESC, segmentNo ASC, trackNo ASC
      `);
    }

    // Convert time format for each entry
    const formattedSetlist = setlist.map((entry) => ({
      ...entry,
      time: mysqlToISO8601(entry.time),
    }));

    // Generate ETag (only for full dataset)
    if (!streamID) {
      const etag = await generateETag(formattedSetlist);

      // Check ETag for 304 Not Modified
      if (checkETagMatch(ifNoneMatch, etag)) {
        return c.body(null, 304, {
          'ETag': etag,
          'Cache-Control': CACHE_CONFIG.HEADERS.NOT_MODIFIED
        });
      }

      return c.json(successResponse(formattedSetlist), 200, {
        'ETag': etag,
        'Cache-Control': CACHE_CONFIG.HEADERS.CACHEABLE
      });
    }

    return c.json(successResponse(formattedSetlist));
  } catch (error) {
    console.error("Get setlist failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", error.message), 500);
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

    // Batch fetch results for response
    const conditions = entries
      .map(() => "(streamID = ? AND trackNo = ?)")
      .join(" OR ");
    const fetchParams = entries.flatMap((entry) => [
      entry.streamID,
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

    return c.json(createErrorResponse("DATABASE_ERROR", error.message), 500);
  }
}

// PUT /setlist/:streamID/:segmentNo/:trackNo - Update setlist entry
export async function updateSetlistEntry(c) {
  const db = c.get("db");
  const streamID = c.req.param("streamID");
  const segmentNo = parseInt(c.req.param("segmentNo"));
  const trackNo = parseInt(c.req.param("trackNo"));
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

  const { songID, note } = body;
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
