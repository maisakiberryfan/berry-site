import { createErrorResponse } from "./database.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);

// Error handling middleware
export async function errorHandler(c, next) {
  try {
    await next();
  } catch (error) {
    console.error("API Error:", error);

    const isDevMode = c.env?.MODE === 'test' || c.env?.MODE === 'dev'
    // In dev/test mode, include the actual error detail for debugging
    const detail = isDevMode ? error.message : undefined

    if (error.message.includes("FOREIGN KEY")) {
      return c.json(
        createErrorResponse(
          "CONSTRAINT_VIOLATION",
          "Cannot delete: record is still referenced",
        ),
        409,
      );
    }

    if (error.message.includes("Duplicate entry")) {
      return c.json(
        createErrorResponse("DUPLICATE_ENTRY", "Record already exists"),
        409,
      );
    }

    if (error.message.includes("Database") || error.code?.startsWith?.('ER_') || error.errno) {
      return c.json(
        createErrorResponse("DATABASE_ERROR", detail || "Database operation failed"),
        500,
      );
    }

    return c.json(
      createErrorResponse("INTERNAL_ERROR", detail || "Internal server error"),
      500,
    );
  }
}

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

export function validateStreamID(streamID) {
  if (!streamID || typeof streamID !== "string" || streamID.length > 64) {
    return "streamID must be a string with max 64 characters";
  }
  return null;
}

export function validateCategories(categories) {
  if (!Array.isArray(categories)) {
    return "categories must be an array";
  }
  if (categories.some((cat) => typeof cat !== "string")) {
    return "all categories must be strings";
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

