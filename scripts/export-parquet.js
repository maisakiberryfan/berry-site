#!/usr/bin/env node
/**
 * MariaDB → Parquet Export Script (Final Integrated Version)
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import parquet from 'parquetjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============ Config from .env ============
const DB_CONFIG = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

const OUTPUT_DIR = process.env.OUTPUT_DIR;
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'berry-data.parquet');

// ============ Shared Log ============
const LOG_FILE = path.join(__dirname, 'backup-and-export.log');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(level, msg) {
  const line = `[${ts()}] ${level} ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  process.stderr.write(line);
}

const info    = (m) => log("INFO", m);
const error   = (m) => log("ERROR", m);
const success = (m) => log("SUCCESS", m);

// ============ SQL ============
const EXPORT_SQL = `
  SELECT
    so.streamID,
    sl.title AS streamTitle,
    sl.time,
    sl.categories,
    sl.setlistComplete,
    so.segmentNo,
    so.trackNo,
    so.songID,
    s.songName,
    s.songNameEn,
    s.artist,
    s.artistEn,
    s.genre,
    s.tieup,
    so.note AS setlistNote,
    s.songNote
  FROM setlist_ori so
  LEFT JOIN streamlist sl ON so.streamID = sl.streamID
  LEFT JOIN songlist s ON so.songID = s.songID
  ORDER BY sl.time DESC, so.segmentNo, so.trackNo
`;

const PARQUET_SCHEMA = new parquet.ParquetSchema({
  streamID: { type: 'UTF8' },
  streamTitle: { type: 'UTF8', optional: true },
  time: { type: 'TIMESTAMP_MILLIS', optional: true },
  categories: { type: 'UTF8', optional: true },
  setlistComplete: { type: 'BOOLEAN', optional: true },
  segmentNo: { type: 'INT32' },
  trackNo: { type: 'INT32' },
  songID: { type: 'UTF8', optional: true },
  songName: { type: 'UTF8', optional: true },
  songNameEn: { type: 'UTF8', optional: true },
  artist: { type: 'UTF8', optional: true },
  artistEn: { type: 'UTF8', optional: true },
  genre: { type: 'UTF8', optional: true },
  tieup: { type: 'UTF8', optional: true },
  setlistNote: { type: 'UTF8', optional: true },
  songNote: { type: 'UTF8', optional: true },
});

// ============ Main Export Function ============
async function exportToParquet() {
  let connection;

  info("----- PARQUET EXPORT START -----");
  info(`Output: ${OUTPUT_PATH}`);

  try {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      info(`Created output directory: ${OUTPUT_DIR}`);
    }

    info("Connecting to MariaDB...");
    connection = await mysql.createConnection(DB_CONFIG);
    info("Connected");

    info("Executing query...");
    const [rows] = await connection.execute(EXPORT_SQL);
    info(`Rows fetched: ${rows.length}`);

    info("Creating writer...");
    const writer = await parquet.ParquetWriter.openFile(PARQUET_SCHEMA, OUTPUT_PATH);

    let idx = 0;
    for (const row of rows) {
      try {
        await writer.appendRow({
          streamID: String(row.streamID ?? ''),
          streamTitle: row.streamTitle ?? '',
          time: row.time ? new Date(row.time).getTime() : null,
          categories: row.categories ?? null,
          setlistComplete: row.setlistComplete != null ? !!row.setlistComplete : null,
          segmentNo: Number(row.segmentNo) || 0,
          trackNo: Number(row.trackNo) || 0,
          songID: row.songID != null ? String(row.songID) : null,
          songName: row.songName ?? '',
          songNameEn: row.songNameEn ?? '',
          artist: row.artist ?? '',
          artistEn: row.artistEn ?? '',
          genre: row.genre ?? '',
          tieup: row.tieup ?? '',
          setlistNote: row.setlistNote ?? '',
          songNote: row.songNote ?? '',
        });

        idx++;

      } catch (err) {
        error(`Row ${idx} failed: ${err.message}`);
        throw err;
      }
    }

    await writer.close();
    const sizeKB = Math.round(fs.statSync(OUTPUT_PATH).size / 1024);

    success(`Parquet file written`);
    info(`Total rows: ${idx}`);
    info(`File size: ${sizeKB} KB`);
    info("----- PARQUET EXPORT END -----");

  } catch (err) {
    error(`Export failed: ${err.message}`);
    info("----- PARQUET EXPORT FAILED -----");
    throw err;

  } finally {
    if (connection) {
      await connection.end();
      info("DB connection closed");
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  exportToParquet()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export default exportToParquet;
