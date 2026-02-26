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
`);

export default db;
