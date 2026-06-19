import { getPagesDb } from '../db/pages-db.js';

let initialized = false;
let _getAll;
let _getOne;
let _setOne;
let _deleteOne;

function parseStoredValue(row) {
  return JSON.parse(row.value);
}

export function initStateStore() {
  if (initialized) return;

  const db = getPagesDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_state (
      artifact TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (artifact, key)
    )
  `);

  _getAll = db.prepare('SELECT key, value FROM artifact_state WHERE artifact = ? ORDER BY key ASC');
  _getOne = db.prepare('SELECT value FROM artifact_state WHERE artifact = ? AND key = ?');
  _setOne = db.prepare(`
    INSERT OR REPLACE INTO artifact_state (artifact, key, value, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  _deleteOne = db.prepare('DELETE FROM artifact_state WHERE artifact = ? AND key = ?');
  initialized = true;
}

function ensureInitialized() {
  if (!initialized) initStateStore();
}

export function getArtifactState(artifact) {
  ensureInitialized();
  const state = {};
  for (const row of _getAll.all(artifact)) {
    state[row.key] = parseStoredValue(row);
  }
  return state;
}

export function getStateValue(artifact, key) {
  ensureInitialized();
  const row = _getOne.get(artifact, key);
  if (!row) return { found: false };
  return { found: true, value: parseStoredValue(row) };
}

export function setStateValue(artifact, key, value) {
  ensureInitialized();
  _setOne.run(artifact, key, JSON.stringify(value), new Date().toISOString());
}

export function deleteStateValue(artifact, key) {
  ensureInitialized();
  _deleteOne.run(artifact, key);
}
