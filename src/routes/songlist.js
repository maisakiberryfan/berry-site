import { validateRequired, successResponse } from "../utils/middleware.js";
import { createErrorResponse } from "../utils/database.js";
import { generateETag, checkETagMatch, CACHE_CONFIG } from "../utils/cache.js";

// GET /songlist - Get all songs (no KV cache, ETag only)
export async function getSonglist(c) {
  try {
    const db = c.get("db");
    const ifNoneMatch = c.req.header('If-None-Match');

    // Always fetch from database
    const songs = await db.query(`
      SELECT songID, songName, songNameEn, artist, artistEn, genre, tieup, songNote, updatedAt
      FROM songlist
      ORDER BY songID DESC
    `);

    // Generate ETag
    const etag = await generateETag(songs);

    // Check ETag for 304 Not Modified
    if (checkETagMatch(ifNoneMatch, etag)) {
      return c.body(null, 304, {
        'ETag': etag,
        'Cache-Control': CACHE_CONFIG.HEADERS.NOT_MODIFIED
      });
    }

    return c.json(successResponse(songs), 200, {
      'ETag': etag,
      'Cache-Control': CACHE_CONFIG.HEADERS.CACHEABLE
    });
  } catch (error) {
    console.error("Get songlist failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", error.message), 500);
  }
}

// GET /songlist/:songID - Get single song by ID
export async function getSongById(c) {
  try {
    const db = c.get("db");
    const songID = c.req.param("songID");

    const song = await db.first(
      `SELECT songID, songName, songNameEn, artist, artistEn, genre, tieup, songNote
       FROM songlist
       WHERE songID = ?`,
      [songID]
    );

    if (!song) {
      return c.json(createErrorResponse("NOT_FOUND", `Song with ID ${songID} not found`), 404);
    }

    return c.json(successResponse(song));
  } catch (error) {
    console.error("Get song by ID failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", error.message), 500);
  }
}

// POST /songlist - Create new song
export async function createSong(c) {
  const db = c.get("db");
  const body = await c.req.json();

  const requiredFields = ["songName"];
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

  const { songName, songNameEn, artist, artistEn, genre, tieup, songNote } =
    body;

  const result = await db.execute(
    "INSERT INTO songlist (songName, songNameEn, artist, artistEn, genre, tieup, songNote) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      songName,
      songNameEn || null,
      artist || null,
      artistEn || null,
      genre || null,
      tieup || null,
      songNote || null,
    ],
  );

  const newSong = await db.first("SELECT * FROM songlist WHERE songID = ?", [
    result.meta.last_row_id,
  ]);

  return c.json(successResponse(newSong), 201);
}

// PUT /songlist/:songID - Update song
export async function updateSong(c) {
  const db = c.get("db");
  const songID = c.req.param("songID");
  const body = await c.req.json();

  // Check if song exists
  const existingSong = await db.first(
    "SELECT * FROM songlist WHERE songID = ?",
    [songID],
  );
  if (!existingSong) {
    return c.json(createErrorResponse("NOT_FOUND", "Song not found"), 404);
  }

  const { songName, songNameEn, artist, artistEn, genre, tieup, songNote } =
    body;
  const updates = [];
  const params = [];

  if (songName !== undefined) {
    updates.push("songName = ?");
    params.push(songName);
  }
  if (songNameEn !== undefined) {
    updates.push("songNameEn = ?");
    params.push(songNameEn);
  }
  if (artist !== undefined) {
    updates.push("artist = ?");
    params.push(artist);
  }
  if (artistEn !== undefined) {
    updates.push("artistEn = ?");
    params.push(artistEn);
  }
  if (genre !== undefined) {
    updates.push("genre = ?");
    params.push(genre);
  }
  if (tieup !== undefined) {
    updates.push("tieup = ?");
    params.push(tieup);
  }
  if (songNote !== undefined) {
    updates.push("songNote = ?");
    params.push(songNote);
  }

  if (updates.length === 0) {
    const existing = await db.first("SELECT * FROM songlist WHERE songID = ?", [songID]);
    return c.json(successResponse(existing), 200);
  }

  params.push(songID);
  await db.execute(
    `UPDATE songlist SET ${updates.join(", ")} WHERE songID = ?`,
    params,
  );

  const updatedSong = await db.first(
    "SELECT * FROM songlist WHERE songID = ?",
    [songID],
  );
  return c.json(successResponse(updatedSong));
}

// DELETE /songlist/:songID - Delete song
export async function deleteSong(c) {
  const db = c.get("db");
  const songID = c.req.param("songID");

  // Check if song exists
  const existingSong = await db.first(
    "SELECT * FROM songlist WHERE songID = ?",
    [songID],
  );
  if (!existingSong) {
    return c.json(createErrorResponse("NOT_FOUND", "Song not found"), 404);
  }

  // Check if song is referenced in setlist
  const references = await db.first(
    "SELECT COUNT(*) as count FROM setlist_ori WHERE songID = ?",
    [songID],
  );
  if (references.count > 0) {
    return c.json(
      createErrorResponse(
        "CONSTRAINT_VIOLATION",
        "Cannot delete song: still referenced in setlist",
      ),
      409,
    );
  }

  await db.execute("DELETE FROM songlist WHERE songID = ?", [songID]);

  return c.json(successResponse({ message: "Song deleted successfully" }));
}

// GET /songlist/artists - Get distinct artists for selection
export async function getArtists(c) {
  try {
    const db = c.get("db");
    const searchTerm = c.req.query("q"); // Get search query parameter

    let query = `
      SELECT DISTINCT artist, artistEn
      FROM songlist
      WHERE artist IS NOT NULL AND artist != ''
    `;
    let params = [];

    // Add search filter if provided
    if (searchTerm && searchTerm.trim()) {
      query += " AND artist LIKE ?";
      params.push(`%${searchTerm.trim()}%`);
    }

    query += " ORDER BY artist";

    const artists = await db.query(query, params);
    return c.json(successResponse(artists));
  } catch (error) {
    console.error("Get artists failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", error.message), 500);
  }
}

// GET /songlist/optimized - Get optimized songlist for AI processing (direct download)
export async function getSonglistOptimized(c) {
  try {
    const db = c.get("db");
    const songs = await db.query(`
      SELECT songID, songName, artist
      FROM songlist
      ORDER BY songID ASC
    `);

    // Convert to optimized format: {"songID": "歌名|歌手"}
    const optimizedSongs = {};
    songs.forEach((song) => {
      const key = song.songID.toString();
      const songName = song.songName || "";
      const artist = song.artist || "";
      optimizedSongs[key] = artist ? `${songName}|${artist}` : songName;
    });

    // Set headers for direct download
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header(
      "Content-Disposition",
      'attachment; filename="songlist-optimized.json"',
    );

    return c.json(successResponse(optimizedSongs));
  } catch (error) {
    console.error("Get optimized songlist failed:", error);
    return c.json(createErrorResponse("DATABASE_ERROR", error.message), 500);
  }
}
