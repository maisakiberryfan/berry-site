import {
  validateRequired,
  validateStreamID,
  validateCategories,
  validateDateTime,
  iso8601ToMySQL,
  mysqlToISO8601,
  successResponse,
} from "../utils/middleware.js";
import { createErrorResponse } from "../utils/database.js";
import { generateETag, checkETagMatch, CACHE_CONFIG } from "../utils/cache.js";

// GET /streamlist - Get all streams (no KV cache, ETag only)
export async function getStreamlist(c) {
  try {
    const db = c.get("db");
    const ifNoneMatch = c.req.header('If-None-Match');

    // Always fetch from database
    const streams = await db.query(`
      SELECT streamID, title, time, categories, note, setlistComplete
      FROM streamlist
      ORDER BY time DESC
    `);

    // Convert JSON categories to array and format time for each stream
    const formattedStreams = streams.map((stream) => ({
      ...stream,
      time: mysqlToISO8601(stream.time),
      categories:
        typeof stream.categories === "string"
          ? JSON.parse(stream.categories)
          : stream.categories,
    }));

    // Generate ETag
    const etag = await generateETag(formattedStreams);

    // Check ETag for 304 Not Modified
    if (checkETagMatch(ifNoneMatch, etag)) {
      return c.body(null, 304, {
        'ETag': etag,
        'Cache-Control': CACHE_CONFIG.HEADERS.NOT_MODIFIED
      });
    }

    return c.json(successResponse(formattedStreams), 200, {
      'ETag': etag,
      'Cache-Control': CACHE_CONFIG.HEADERS.CACHEABLE
    });
  } catch (error) {
    console.error("Get streamlist failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", error.message), 500);
  }
}

// GET /streamlist/:streamID - Get single stream by ID
export async function getStreamById(c) {
  try {
    const db = c.get("db");
    const streamID = c.req.param("streamID");

    const stream = await db.first(
      "SELECT streamID, title, time, categories, note, setlistComplete FROM streamlist WHERE streamID = ?",
      [streamID],
    );

    if (!stream) {
      return c.json(createErrorResponse("NOT_FOUND", "Stream not found"), 404);
    }

    const formattedStream = {
      ...stream,
      time: mysqlToISO8601(stream.time),
      categories:
        typeof stream.categories === "string"
          ? JSON.parse(stream.categories)
          : stream.categories,
    };

    return c.json(successResponse(formattedStream));
  } catch (error) {
    console.error("Get stream by ID failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", error.message), 500);
  }
}

// POST /streamlist - Create new stream
export async function createStream(c) {
  const db = c.get("db");
  const body = await c.req.json();

  const requiredFields = ["streamID", "title", "time", "categories"];
  const fieldErrors = validateRequired(body, requiredFields);

  if (fieldErrors) {
    return c.json(
      createErrorResponse(
        "VALIDATION_ERROR",
        "Required fields missing",
        fieldErrors,
      ),
      400,
    );
  }

  const { streamID, title, time, categories, note } = body;

  // Validate streamID
  const streamIDError = validateStreamID(streamID);
  if (streamIDError) {
    return c.json(createErrorResponse("VALIDATION_ERROR", streamIDError), 400);
  }

  // Validate categories
  const categoriesError = validateCategories(categories);
  if (categoriesError) {
    return c.json(
      createErrorResponse("VALIDATION_ERROR", categoriesError),
      400,
    );
  }

  // Validate datetime
  const dateTimeError = validateDateTime(time);
  if (dateTimeError) {
    return c.json(createErrorResponse("VALIDATION_ERROR", dateTimeError), 400);
  }

  // Convert ISO 8601 to MySQL DATETIME format before inserting
  const mysqlTime = iso8601ToMySQL(time);

  // Auto-set setlistComplete based on categories
  const isSingingStream = categories.some(cat => cat.includes('歌枠'));
  const setlistComplete = !isSingingStream; // false for singing streams (need parsing), true otherwise

  try {
    const result = await db.execute(
      "INSERT INTO streamlist (streamID, title, time, categories, note, setlistComplete) VALUES (?, ?, ?, ?, ?, ?)",
      [streamID, title, mysqlTime, JSON.stringify(categories), note || null, setlistComplete],
    );

    const newStream = await db.first(
      "SELECT * FROM streamlist WHERE streamID = ?",
      [streamID],
    );
    const formattedStream = {
      ...newStream,
      time: mysqlToISO8601(newStream.time),
      categories: JSON.parse(newStream.categories),
    };

    return c.json(successResponse(formattedStream), 201);
  } catch (error) {
    // Handle duplicate primary key error (ER_DUP_ENTRY, errno 1062)
    if (error.code === "ER_DUP_ENTRY" || error.message?.includes("Duplicate entry")) {
      return c.json(
        createErrorResponse("CONFLICT", `Stream already exists: ${streamID}`),
        409,
      );
    }
    throw error;
  }
}

// PUT /streamlist/:streamID - Update stream
export async function updateStream(c) {
  const db = c.get("db");
  const streamID = c.req.param("streamID");
  const body = await c.req.json();

  // Check if stream exists
  const existingStream = await db.first(
    "SELECT * FROM streamlist WHERE streamID = ?",
    [streamID],
  );
  if (!existingStream) {
    return c.json(createErrorResponse("NOT_FOUND", "Stream not found"), 404);
  }

  const { title, time, categories, note, setlistComplete } = body;
  const updates = [];
  const params = [];

  if (title !== undefined) {
    updates.push("title = ?");
    params.push(title);
  }
  if (time !== undefined) {
    const dateTimeError = validateDateTime(time);
    if (dateTimeError) {
      return c.json(
        createErrorResponse("VALIDATION_ERROR", dateTimeError),
        400,
      );
    }
    // Convert ISO 8601 to MySQL DATETIME format before updating
    const mysqlTime = iso8601ToMySQL(time);
    updates.push("time = ?");
    params.push(mysqlTime);
  }
  if (categories !== undefined) {
    const categoriesError = validateCategories(categories);
    if (categoriesError) {
      return c.json(
        createErrorResponse("VALIDATION_ERROR", categoriesError),
        400,
      );
    }
    updates.push("categories = ?");
    params.push(JSON.stringify(categories));

    // Auto-update setlistComplete when categories change (unless explicitly set)
    if (setlistComplete === undefined) {
      const isSingingStream = categories.some(cat => cat.includes('歌枠'));
      updates.push("setlistComplete = ?");
      params.push(!isSingingStream);
    }
  }
  if (note !== undefined) {
    updates.push("note = ?");
    params.push(note);
  }
  if (setlistComplete !== undefined) {
    updates.push("setlistComplete = ?");
    params.push(setlistComplete);
  }

  if (updates.length === 0) {
    return c.json(successResponse(existingStream), 200);
  }

  params.push(streamID);
  await db.execute(
    `UPDATE streamlist SET ${updates.join(", ")} WHERE streamID = ?`,
    params,
  );

  const updatedStream = await db.first(
    "SELECT * FROM streamlist WHERE streamID = ?",
    [streamID],
  );
  const formattedStream = {
    ...updatedStream,
    time: mysqlToISO8601(updatedStream.time),
    categories: JSON.parse(updatedStream.categories),
  };

  return c.json(successResponse(formattedStream));
}

// DELETE /streamlist/:streamID - Delete stream
export async function deleteStream(c) {
  const db = c.get("db");
  const streamID = c.req.param("streamID");

  // Check if stream exists
  const existingStream = await db.first(
    "SELECT * FROM streamlist WHERE streamID = ?",
    [streamID],
  );
  if (!existingStream) {
    return c.json(createErrorResponse("NOT_FOUND", "Stream not found"), 404);
  }

  // Check if stream is referenced in setlist
  const references = await db.first(
    "SELECT COUNT(*) as count FROM setlist_ori WHERE streamID = ?",
    [streamID],
  );
  if (references.count > 0) {
    return c.json(
      createErrorResponse(
        "CONSTRAINT_VIOLATION",
        "Cannot delete stream: still referenced in setlist",
      ),
      409,
    );
  }

  await db.execute("DELETE FROM streamlist WHERE streamID = ?", [streamID]);

  return c.json(successResponse({ message: "Stream deleted successfully" }));
}

// PATCH /streamlist/bulk-categories - Update categories for multiple streams
export async function bulkUpdateCategories(c) {
  const db = c.get("db");
  const body = await c.req.json();

  const requiredFields = ["streamIDs", "categories"];
  const fieldErrors = validateRequired(body, requiredFields);

  if (fieldErrors) {
    return c.json(
      createErrorResponse(
        "VALIDATION_ERROR",
        "Required fields missing",
        fieldErrors,
      ),
      400,
    );
  }

  const { streamIDs, categories } = body;

  if (!Array.isArray(streamIDs) || streamIDs.length === 0) {
    return c.json(
      createErrorResponse(
        "VALIDATION_ERROR",
        "streamIDs must be a non-empty array",
      ),
      400,
    );
  }

  const categoriesError = validateCategories(categories);
  if (categoriesError) {
    return c.json(
      createErrorResponse("VALIDATION_ERROR", categoriesError),
      400,
    );
  }

  const placeholders = streamIDs.map(() => "?").join(",");
  const params = [JSON.stringify(categories), ...streamIDs];

  const result = await db.execute(
    `UPDATE streamlist SET categories = ? WHERE streamID IN (${placeholders})`,
    params,
  );

  return c.json(
    successResponse({
      message: `Updated categories for ${result.meta.changes} streams`,
    }),
  );
}

// GET /streamlist/pending - Get pending streams (setlistComplete = false)
export async function getPendingStreams(c) {
  try {
    const db = c.get("db");
    const recent = c.req.query("recent"); // Query parameter: ?recent=true

    let query = `
      SELECT streamID, title, time, categories, note, setlistComplete
      FROM streamlist
      WHERE setlistComplete = FALSE
        AND JSON_SEARCH(categories, 'one', '%歌枠%') IS NOT NULL
    `;

    const params = [];

    // If recent=true, only get streams from last 7 days
    if (recent === "true") {
      query += ` AND time >= DATE_SUB(NOW(), INTERVAL 7 DAY)`;
    }

    query += ` ORDER BY time DESC`;

    const pendingStreams = await db.query(query, params);

    // Convert JSON categories to array and format time for each stream
    const formattedStreams = pendingStreams.map((stream) => ({
      ...stream,
      // Convert DATETIME string to ISO8601 UTC format
      time: mysqlToISO8601(stream.time),
      categories:
        typeof stream.categories === "string"
          ? JSON.parse(stream.categories)
          : stream.categories,
    }));

    return c.json(successResponse(formattedStreams));
  } catch (error) {
    console.error("Get pending streams failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", error.message), 500);
  }
}

// GET /streamlist/latest - Get latest stream time (for YTID baseline)
export async function getLatestStream(c) {
  try {
    const db = c.get("db");
    const stream = await db.first(`
      SELECT time
      FROM streamlist
      ORDER BY time DESC
      LIMIT 1
    `);

    if (!stream) {
      return c.json(successResponse({ time: null }));
    }

    // Convert DATETIME to ISO8601 format
    const formattedTime = mysqlToISO8601(stream.time);

    return c.json(successResponse({ time: formattedTime }));
  } catch (error) {
    console.error("Get latest stream failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", error.message), 500);
  }
}
