import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'vin.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    display_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS saved_vins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vin TEXT NOT NULL,
    label TEXT,
    year INTEGER,
    make TEXT,
    model TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, vin)
  );

  CREATE INDEX IF NOT EXISTS idx_saved_vins_user ON saved_vins(user_id);

  CREATE TABLE IF NOT EXISTS output_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    show_overview INTEGER DEFAULT 1,
    show_engine INTEGER DEFAULT 1,
    show_safety_ratings INTEGER DEFAULT 1,
    show_fuel_economy INTEGER DEFAULT 1,
    show_recalls INTEGER DEFAULT 1,
    show_complaints INTEGER DEFAULT 1,
    show_safety_equipment INTEGER DEFAULT 1,
    show_photos INTEGER DEFAULT 1,
    show_raw_nhtsa INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Observability: request log
  CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    ip TEXT,
    method TEXT,
    path TEXT,
    status INTEGER,
    duration_ms INTEGER,
    user_agent TEXT,
    user_id INTEGER,
    bytes INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_reqlog_ts ON request_log(ts);
  CREATE INDEX IF NOT EXISTS idx_reqlog_ip ON request_log(ip);
  CREATE INDEX IF NOT EXISTS idx_reqlog_path ON request_log(path);

  -- Observability: security events
  CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    event_type TEXT NOT NULL,
    ip TEXT,
    detail TEXT,
    severity TEXT DEFAULT 'info'
  );

  CREATE INDEX IF NOT EXISTS idx_secevents_ts ON security_events(ts);
  CREATE INDEX IF NOT EXISTS idx_secevents_type ON security_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_secevents_ip ON security_events(ip);
`);

// Prepared statements for hot-path logging (avoid re-parsing SQL)
export const logRequest = db.prepare(
  'INSERT INTO request_log (ip, method, path, status, duration_ms, user_agent, user_id, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
export const logSecurityEvent = db.prepare(
  'INSERT INTO security_events (event_type, ip, detail, severity) VALUES (?, ?, ?, ?)'
);

// Prune old logs (keep 30 days)
export function pruneOldLogs() {
  db.prepare("DELETE FROM request_log WHERE ts < datetime('now', '-30 days')").run();
  db.prepare("DELETE FROM security_events WHERE ts < datetime('now', '-90 days')").run();
}

export default db;
