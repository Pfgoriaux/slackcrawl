import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initEnrichmentSchema } from "./enrich-db";

export type DB = Database;

export function openDB(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA cache_size=10000");
  db.exec("PRAGMA busy_timeout=5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      domain     TEXT,
      synced_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS channels (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL,
      name           TEXT,
      is_private     INTEGER DEFAULT 0,
      is_archived    INTEGER DEFAULT 0,
      topic          TEXT,
      purpose        TEXT,
      member_count   INTEGER DEFAULT 0,
      created_at     INTEGER,
      synced_at      INTEGER,
      last_synced_ts  TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      username      TEXT,
      real_name     TEXT,
      display_name  TEXT,
      email         TEXT,
      title         TEXT,
      is_bot        INTEGER DEFAULT 0,
      is_deleted    INTEGER DEFAULT 0,
      avatar_url    TEXT,
      synced_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      ts              TEXT NOT NULL,
      thread_ts       TEXT,
      subtype         TEXT,
      user_id         TEXT,
      username        TEXT,
      text            TEXT,
      has_attachments INTEGER DEFAULT 0,
      has_files       INTEGER DEFAULT 0,
      reactions       TEXT,
      reply_count     INTEGER DEFAULT 0,
      reply_users     TEXT,
      edited_ts       TEXT,
      created_at      INTEGER,
      deleted_at      INTEGER,
      raw_json        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, ts);
    CREATE INDEX IF NOT EXISTS idx_messages_workspace  ON messages(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user       ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created    ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_thread     ON messages(channel_id, thread_ts);
    CREATE INDEX IF NOT EXISTS idx_channels_workspace  ON channels(workspace_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      username,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text, username)
      VALUES (new.rowid, new.text, new.username);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text, username)
      VALUES ('delete', old.rowid, old.text, old.username);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text, username)
      VALUES ('delete', old.rowid, old.text, old.username);
      INSERT INTO messages_fts(rowid, text, username)
      VALUES (new.rowid, new.text, new.username);
    END;
  `);

  migrateMessages(db);
  initEnrichmentSchema(db);

  return db;
}

/** Add columns introduced after the initial release to pre-existing databases. */
function migrateMessages(db: Database) {
  const cols = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((r) => r.name),
  );
  if (!cols.has("subtype")) db.exec("ALTER TABLE messages ADD COLUMN subtype TEXT");
  if (!cols.has("deleted_at")) db.exec("ALTER TABLE messages ADD COLUMN deleted_at INTEGER");
}
