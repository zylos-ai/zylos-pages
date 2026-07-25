import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../lib/config.js';
import { logger } from '../utils/logger.js';

const DB_PATH = path.join(DATA_DIR, 'pages.db');

let db;

export function getPagesDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    logger.info('pages db initialized', { path: DB_PATH });
  }
  return db;
}

export function tableExists(database, table) {
  return Boolean(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

// Idempotent ALTER for tables that predate a column. Lives here because two
// modules need it on the same table and importing one from the other would
// close an import cycle (share-manager already imports page-store).
export function addColumnIfMissing(database, table, column, definition) {
  if (!tableExists(database, table)) return false;
  const present = database.prepare(`PRAGMA table_info(${table})`).all().some(col => col.name === column);
  if (present) return false;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  logger.info('column added', { table, column });
  return true;
}

export function closePagesDb() {
  if (!db) return;
  db.close();
  db = undefined;
}
