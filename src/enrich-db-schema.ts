import type { Database } from "bun:sqlite";

// ---- Schema ----

export function initEnrichmentSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_log (
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      model        TEXT,
      token_count  INTEGER DEFAULT 0,
      created_at   INTEGER DEFAULT (unixepoch()),
      UNIQUE(entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS thread_summaries (
      channel_id    TEXT NOT NULL,
      thread_ts     TEXT NOT NULL,
      summary       TEXT NOT NULL,
      participants  TEXT, -- JSON array
      message_count INTEGER DEFAULT 0,
      last_reply_ts TEXT,
      created_at    INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (channel_id, thread_ts)
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id   TEXT NOT NULL,
      thread_ts    TEXT NOT NULL,
      decision     TEXT NOT NULL,
      category     TEXT NOT NULL, -- decision|action_item|conclusion|commitment
      participants TEXT, -- JSON array
      decided_at   INTEGER,
      created_at   INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_decisions_channel ON decisions(channel_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_thread ON decisions(channel_id, thread_ts);

    CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
      decision,
      category,
      content='decisions',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
      INSERT INTO decisions_fts(rowid, decision, category)
      VALUES (new.id, new.decision, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
      INSERT INTO decisions_fts(decisions_fts, rowid, decision, category)
      VALUES ('delete', old.id, old.decision, old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
      INSERT INTO decisions_fts(decisions_fts, rowid, decision, category)
      VALUES ('delete', old.id, old.decision, old.category);
      INSERT INTO decisions_fts(rowid, decision, category)
      VALUES (new.id, new.decision, new.category);
    END;

    CREATE TABLE IF NOT EXISTS channel_digests (
      channel_id  TEXT NOT NULL,
      date        TEXT NOT NULL, -- YYYY-MM-DD
      summary     TEXT NOT NULL, -- markdown
      key_topics  TEXT, -- JSON array
      message_count INTEGER DEFAULT 0,
      thread_count  INTEGER DEFAULT 0,
      participant_count INTEGER DEFAULT 0,
      created_at  INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (channel_id, date)
    );

    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id  TEXT PRIMARY KEY,
      embedding   BLOB NOT NULL, -- Float32Array as bytes
      model       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id    TEXT PRIMARY KEY,
      expertise  TEXT, -- JSON array [{topic, confidence, channels}]
      summary    TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS user_profiles_fts USING fts5(
      expertise,
      summary,
      content='user_profiles',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS user_profiles_ai AFTER INSERT ON user_profiles BEGIN
      INSERT INTO user_profiles_fts(rowid, expertise, summary)
      VALUES (new.rowid, new.expertise, new.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS user_profiles_ad AFTER DELETE ON user_profiles BEGIN
      INSERT INTO user_profiles_fts(user_profiles_fts, rowid, expertise, summary)
      VALUES ('delete', old.rowid, old.expertise, old.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS user_profiles_au AFTER UPDATE ON user_profiles BEGIN
      INSERT INTO user_profiles_fts(user_profiles_fts, rowid, expertise, summary)
      VALUES ('delete', old.rowid, old.expertise, old.summary);
      INSERT INTO user_profiles_fts(rowid, expertise, summary)
      VALUES (new.rowid, new.expertise, new.summary);
    END;
  `);
}

export function markEnriched(
  db: Database,
  entityType: string,
  entityId: string,
  model: string,
  tokenCount: number,
) {
  db.run(
    `INSERT INTO enrichment_log(entity_type, entity_id, model, token_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET model=excluded.model, token_count=excluded.token_count, created_at=unixepoch()`,
    [entityType, entityId, model, tokenCount],
  );
}
