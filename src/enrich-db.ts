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

// ---- Enrichment log ----

export function markEnriched(db: Database, entityType: string, entityId: string, model: string, tokenCount: number) {
  db.run(
    `INSERT INTO enrichment_log(entity_type, entity_id, model, token_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET model=excluded.model, token_count=excluded.token_count, created_at=unixepoch()`,
    [entityType, entityId, model, tokenCount],
  );
}

// ---- Thread summaries ----

export interface ThreadSummary {
  channel_id: string;
  thread_ts: string;
  summary: string;
  participants: string | null;
  message_count: number;
  last_reply_ts: string | null;
  created_at: number;
}

export function upsertThreadSummary(db: Database, s: Omit<ThreadSummary, "created_at">) {
  db.run(
    `INSERT INTO thread_summaries(channel_id, thread_ts, summary, participants, message_count, last_reply_ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
       summary=excluded.summary, participants=excluded.participants,
       message_count=excluded.message_count, last_reply_ts=excluded.last_reply_ts, created_at=unixepoch()`,
    [s.channel_id, s.thread_ts, s.summary, s.participants, s.message_count, s.last_reply_ts],
  );
}

export function getThreadSummary(db: Database, channelId: string, threadTs: string): ThreadSummary | null {
  return db.query<ThreadSummary, [string, string]>(
    "SELECT * FROM thread_summaries WHERE channel_id = ? AND thread_ts = ?",
  ).get(channelId, threadTs);
}

export function getThreadSummaries(db: Database, channelId: string, since?: number): ThreadSummary[] {
  if (since) {
    return db.query<ThreadSummary, [string, number]>(
      "SELECT * FROM thread_summaries WHERE channel_id = ? AND created_at >= ? ORDER BY thread_ts DESC",
    ).all(channelId, since);
  }
  return db.query<ThreadSummary, [string]>(
    "SELECT * FROM thread_summaries WHERE channel_id = ? ORDER BY thread_ts DESC",
  ).all(channelId);
}

/** Find threads that need summarization: 2+ replies, no summary or stale summary */
export function getUnsummarizedThreads(db: Database, minReplies: number): { channel_id: string; thread_ts: string; reply_count: number; last_reply_ts: string }[] {
  return db.query<
    { channel_id: string; thread_ts: string; reply_count: number; last_reply_ts: string },
    [number]
  >(`
    SELECT m.channel_id, m.ts as thread_ts, m.reply_count,
           (SELECT MAX(r.ts) FROM messages r WHERE r.channel_id = m.channel_id AND r.thread_ts = m.ts) as last_reply_ts
    FROM messages m
    WHERE m.reply_count >= ?
      AND m.thread_ts IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM thread_summaries ts
        WHERE ts.channel_id = m.channel_id AND ts.thread_ts = m.ts
          AND ts.last_reply_ts = (SELECT MAX(r.ts) FROM messages r WHERE r.channel_id = m.channel_id AND r.thread_ts = m.ts)
      )
      AND NOT EXISTS (
        SELECT 1 FROM enrichment_log e
        WHERE e.entity_type = 'thread_summary' AND e.entity_id = m.channel_id || ':' || m.ts
          AND EXISTS (
            SELECT 1 FROM thread_summaries ts2
            WHERE ts2.channel_id = m.channel_id AND ts2.thread_ts = m.ts
              AND ts2.last_reply_ts = (SELECT MAX(r.ts) FROM messages r WHERE r.channel_id = m.channel_id AND r.thread_ts = m.ts)
          )
      )
    ORDER BY m.created_at DESC
  `).all(minReplies);
}

// ---- Decisions ----

export interface Decision {
  id: number;
  channel_id: string;
  thread_ts: string;
  decision: string;
  category: string;
  participants: string | null;
  decided_at: number | null;
  created_at: number;
}

export function insertDecision(db: Database, d: Omit<Decision, "id" | "created_at">) {
  db.run(
    `INSERT INTO decisions(channel_id, thread_ts, decision, category, participants, decided_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [d.channel_id, d.thread_ts, d.decision, d.category, d.participants, d.decided_at],
  );
}

export function getDecisionsByThread(db: Database, channelId: string, threadTs: string): Decision[] {
  return db.query<Decision, [string, string]>(
    "SELECT * FROM decisions WHERE channel_id = ? AND thread_ts = ? ORDER BY decided_at",
  ).all(channelId, threadTs);
}

export function queryDecisions(db: Database, opts: {
  channelId?: string;
  channelName?: string;
  since?: number;
  query?: string;
  category?: string;
  limit?: number;
}): Decision[] {
  const limit = opts.limit ?? 50;

  // FTS path
  if (opts.query) {
    const conds: string[] = ["decisions_fts MATCH ?"];
    const args: (string | number)[] = [opts.query];
    if (opts.channelId) { conds.push("d.channel_id = ?"); args.push(opts.channelId); }
    else if (opts.channelName) { conds.push("(d.channel_id = ? OR c.name = ?)"); args.push(opts.channelName, opts.channelName); }
    if (opts.since) { conds.push("d.decided_at >= ?"); args.push(opts.since); }
    if (opts.category) { conds.push("d.category = ?"); args.push(opts.category); }
    args.push(limit);
    return db.query<Decision, (string | number)[]>(
      `SELECT d.* FROM decisions_fts
       JOIN decisions d ON decisions_fts.rowid = d.id
       LEFT JOIN channels c ON d.channel_id = c.id
       WHERE ${conds.join(" AND ")}
       ORDER BY rank LIMIT ?`,
    ).all(...args);
  }

  // Non-FTS path
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (opts.channelId) { conds.push("d.channel_id = ?"); args.push(opts.channelId); }
  else if (opts.channelName) { conds.push("(d.channel_id = ? OR c.name = ?)"); args.push(opts.channelName, opts.channelName); }
  if (opts.since) { conds.push("d.decided_at >= ?"); args.push(opts.since); }
  if (opts.category) { conds.push("d.category = ?"); args.push(opts.category); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  args.push(limit);
  return db.query<Decision, (string | number)[]>(
    `SELECT d.* FROM decisions d
     LEFT JOIN channels c ON d.channel_id = c.id
     ${where} ORDER BY d.decided_at DESC LIMIT ?`,
  ).all(...args);
}

// ---- Channel digests ----

export interface ChannelDigest {
  channel_id: string;
  date: string;
  summary: string;
  key_topics: string | null;
  message_count: number;
  thread_count: number;
  participant_count: number;
  created_at: number;
}

export function upsertChannelDigest(db: Database, d: Omit<ChannelDigest, "created_at">) {
  db.run(
    `INSERT INTO channel_digests(channel_id, date, summary, key_topics, message_count, thread_count, participant_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, date) DO UPDATE SET
       summary=excluded.summary, key_topics=excluded.key_topics,
       message_count=excluded.message_count, thread_count=excluded.thread_count,
       participant_count=excluded.participant_count, created_at=unixepoch()`,
    [d.channel_id, d.date, d.summary, d.key_topics, d.message_count, d.thread_count, d.participant_count],
  );
}

export function getChannelDigests(db: Database, opts: {
  channelId?: string;
  channelName?: string;
  date?: string;
  days?: number;
}): ChannelDigest[] {
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (opts.channelId) { conds.push("d.channel_id = ?"); args.push(opts.channelId); }
  else if (opts.channelName) { conds.push("(d.channel_id = ? OR c.name = ?)"); args.push(opts.channelName, opts.channelName); }
  if (opts.date) { conds.push("d.date = ?"); args.push(opts.date); }
  else if (opts.days) {
    const since = new Date();
    since.setDate(since.getDate() - opts.days);
    conds.push("d.date >= ?");
    args.push(since.toISOString().slice(0, 10));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return db.query<ChannelDigest, (string | number)[]>(
    `SELECT d.* FROM channel_digests d
     LEFT JOIN channels c ON d.channel_id = c.id
     ${where} ORDER BY d.date DESC`,
  ).all(...args);
}

/** Find dates with messages but no digest */
export function getUndigestedDates(db: Database): { channel_id: string; date: string; msg_count: number }[] {
  return db.query<{ channel_id: string; date: string; msg_count: number }, []>(`
    SELECT m.channel_id, DATE(m.created_at, 'unixepoch') as date, COUNT(*) as msg_count
    FROM messages m
    WHERE m.thread_ts IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM channel_digests cd
        WHERE cd.channel_id = m.channel_id AND cd.date = DATE(m.created_at, 'unixepoch')
      )
      AND DATE(m.created_at, 'unixepoch') < DATE('now')
    GROUP BY m.channel_id, date
    HAVING msg_count >= 3
    ORDER BY date DESC
  `).all();
}

// ---- Message embeddings ----

export function upsertEmbedding(db: Database, messageId: string, embedding: Float32Array, model: string) {
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.run(
    `INSERT INTO message_embeddings(message_id, embedding, model) VALUES (?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET embedding=excluded.embedding, model=excluded.model`,
    [messageId, buf, model],
  );
}

export function getUnembeddedMessages(db: Database, limit: number): { id: string; text: string }[] {
  return db.query<{ id: string; text: string }, [number]>(`
    SELECT m.id, m.text
    FROM messages m
    WHERE m.text IS NOT NULL AND m.text != ''
      AND NOT EXISTS (SELECT 1 FROM message_embeddings me WHERE me.message_id = m.id)
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit);
}

export function getAllEmbeddings(db: Database): { message_id: string; embedding: Buffer }[] {
  return db.query<{ message_id: string; embedding: Buffer }, []>(
    "SELECT message_id, embedding FROM message_embeddings",
  ).all();
}

// ---- User profiles ----

export interface UserProfile {
  user_id: string;
  expertise: string | null;
  summary: string | null;
  updated_at: number;
}

export function upsertUserProfile(db: Database, p: Omit<UserProfile, "updated_at">) {
  db.run(
    `INSERT INTO user_profiles(user_id, expertise, summary) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET expertise=excluded.expertise, summary=excluded.summary, updated_at=unixepoch()`,
    [p.user_id, p.expertise, p.summary],
  );
}

export function getUserProfile(db: Database, userId: string): UserProfile | null {
  return db.query<UserProfile, [string]>("SELECT * FROM user_profiles WHERE user_id = ?").get(userId);
}

export function searchExpertise(db: Database, query: string, limit = 20): (UserProfile & { user_id: string })[] {
  return db.query<UserProfile & { user_id: string }, [string, number]>(
    `SELECT up.* FROM user_profiles_fts
     JOIN user_profiles up ON user_profiles_fts.rowid = up.rowid
     WHERE user_profiles_fts MATCH ?
     ORDER BY rank LIMIT ?`,
  ).all(query, limit);
}

export function getUsersNeedingProfiles(db: Database): { user_id: string; username: string; message_count: number }[] {
  return db.query<{ user_id: string; username: string; message_count: number }, []>(`
    SELECT m.user_id, COALESCE(u.username, m.username) as username, COUNT(*) as message_count
    FROM messages m
    LEFT JOIN users u ON m.user_id = u.id
    WHERE m.user_id IS NOT NULL
      AND (
        NOT EXISTS (SELECT 1 FROM user_profiles up WHERE up.user_id = m.user_id)
        OR (SELECT updated_at FROM user_profiles up2 WHERE up2.user_id = m.user_id) < unixepoch() - 86400
      )
    GROUP BY m.user_id
    HAVING message_count >= 5
    ORDER BY message_count DESC
  `).all();
}

// ---- Stats ----

export function getEnrichmentStats(db: Database) {
  const count = (table: string) =>
    (db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM ${table}`).get()?.n ?? 0);
  return {
    thread_summaries: count("thread_summaries"),
    decisions: count("decisions"),
    channel_digests: count("channel_digests"),
    message_embeddings: count("message_embeddings"),
    user_profiles: count("user_profiles"),
    enrichment_log: count("enrichment_log"),
  };
}
