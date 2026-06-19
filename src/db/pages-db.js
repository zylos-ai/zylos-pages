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

export function closePagesDb() {
  if (!db) return;
  db.close();
  db = undefined;
}
