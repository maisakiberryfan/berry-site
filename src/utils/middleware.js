import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);

// 錯誤處理已遷移至 src/app.js 的 `app.onError`——掛成中介層時 Hono 的 compose
// 會在更內層就把錯誤交給 onError 並吞掉，此處的 try/catch 永遠等不到錯誤。

// Request validation helpers
export function validateRequired(data, fields) {
  const errors = {};
  for (const field of fields) {
    // Explicitly check undefined and null, allow numeric 0 and boolean false
    if (
      data[field] === undefined ||
      data[field] === null ||
      (typeof data[field] === "string" && data[field].trim() === "")
    ) {
      errors[field] = `${field} is required`;
    }
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Maximum accepted lengths for user-supplied string fields.
 * Values keep headroom over the longest rows currently stored
 * (e.g. artistEn reaches 148 chars, so 100 would break legitimate updates).
 *
 * Scope note: these limits apply to the HTTP write paths only. The internal
 * ingestion helpers in src/utils/data-processor.js (batchCreateStreams,
 * createNewSong, batchCreateSetlist) call db.execute directly and pass through
 * neither validateStreamID nor validateLength. They stay in range today because
 * of three implicit assumptions — YouTube titles are short, streamID is always
 * 11 chars, and the target columns are varchar(512). If any of those columns is
 * widened later, add explicit checks on those paths too.
 */
export const FIELD_LIMITS = {
  // varchar(512) columns — the DB already caps these; program-level limit is defence in depth
  title: 500,
  note: 500,
  songName: 500,
  songNameEn: 500,
  artist: 500,
  artistEn: 500,
  genre: 500,
  tieup: 500,
  songNote: 500,
  canonicalName: 500,
  aliasValue: 500,
  aliasNote: 500,
  // TEXT column (64KB) — batch endpoints multiply this, so the cap matters
  setlistNote: 1000,
  // categories is LONGTEXT (genuinely unbounded) and bulk-categories fans one
  // payload out over up to 100 streams, so both size and item count are capped
  categoryItem: 100,
  categoriesCount: 20,
};

/**
 * Length guard for a single field. undefined/null pass through (callers decide
 * whether a field is required); everything else is measured as a string.
 */
export function validateLength(value, fieldName, maxLength) {
  if (value === undefined || value === null) return null;
  if (String(value).length > maxLength) {
    return `${fieldName} exceeds maximum length of ${maxLength} characters`;
  }
  return null;
}

/**
 * Validate several fields at once.
 * @param {Object} data - source object
 * @param {Object} limits - { fieldName: maxLength }
 * @returns {string|null} first error message, or null when all pass
 */
export function validateLengths(data, limits) {
  for (const [field, maxLength] of Object.entries(limits)) {
    const error = validateLength(data[field], field, maxLength);
    if (error) return error;
  }
  return null;
}

export function validateStreamID(streamID) {
  if (!streamID || typeof streamID !== "string") {
    return "streamID must be a non-empty string";
  }
  // YouTube video IDs are 11 chars; a few legacy placeholder rows are 9.
  // The character class also keeps markup/quote characters out of stored IDs.
  if (!/^[A-Za-z0-9_-]{9,11}$/.test(streamID)) {
    return "streamID must be 9-11 characters of A-Z, a-z, 0-9, _ or -";
  }
  return null;
}

export function validateCategories(categories) {
  if (!Array.isArray(categories)) {
    return "categories must be an array";
  }
  if (categories.length > FIELD_LIMITS.categoriesCount) {
    return `categories must contain at most ${FIELD_LIMITS.categoriesCount} items`;
  }
  if (categories.some((cat) => typeof cat !== "string")) {
    return "all categories must be strings";
  }
  if (categories.some((cat) => cat.length > FIELD_LIMITS.categoryItem)) {
    return `each category must be at most ${FIELD_LIMITS.categoryItem} characters`;
  }
  return null;
}

export function validateDateTime(dateTime) {
  const date = new Date(dateTime);
  if (isNaN(date.getTime())) {
    return "Invalid datetime format, use ISO8601";
  }
  return null;
}

/**
 * Convert ISO 8601 datetime to MySQL DATETIME format (UTC)
 * @param {string} isoTime - ISO 8601 format (e.g., '2025-10-03T13:00:00Z' or '2025-10-03T13:00:00.000Z')
 * @returns {string} MySQL DATETIME format in UTC (e.g., '2025-10-03 13:00:00')
 */
export function iso8601ToMySQL(isoTime) {
  if (!isoTime) return isoTime;

  // Parse as UTC and format to MySQL DATETIME
  const date = dayjs.utc(isoTime);
  if (!date.isValid()) return isoTime;

  return date.format('YYYY-MM-DD HH:mm:ss');
}

/**
 * Convert MySQL DATETIME to ISO 8601 format (UTC)
 * @param {string} mysqlTime - MySQL DATETIME format (e.g., '2025-10-03 13:00:00' or '2025-10-03 13:00:00.000000')
 * @returns {string} ISO 8601 format in UTC (e.g., '2025-10-03T13:00:00.000Z')
 */
export function mysqlToISO8601(mysqlTime) {
  if (!mysqlTime) return mysqlTime;
  if (typeof mysqlTime !== "string") return mysqlTime;

  // Remove microseconds if present (MariaDB may return .000000)
  const cleaned = mysqlTime.replace(/\.\d+$/, '');

  // Parse MySQL DATETIME as UTC and convert to ISO8601
  const date = dayjs.utc(cleaned, 'YYYY-MM-DD HH:mm:ss');
  if (!date.isValid()) return mysqlTime;

  return date.toISOString();
}

// Response helpers
export function successResponse(data) {
  return { data };
}

