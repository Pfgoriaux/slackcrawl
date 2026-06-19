import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
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
    db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((r) => r.name),
  );
  if (!cols.has("subtype"))    db.exec("ALTER TABLE messages ADD COLUMN subtype TEXT");
  if (!cols.has("deleted_at")) db.exec("ALTER TABLE messages ADD COLUMN deleted_at INTEGER");
}

// Slack system/noise message subtypes excluded from search and enrichment
// (still stored, so nothing is lost — just kept out of the signal paths).
export const NOISE_SUBTYPES = [
  "channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name",
  "channel_archive", "channel_unarchive", "group_join", "group_leave", "group_topic",
  "group_purpose", "group_name", "group_archive", "group_unarchive", "bot_add", "bot_remove",
  "pinned_item", "unpinned_item", "reminder_add",
];
const NOISE_LIST = NOISE_SUBTYPES.map((s) => `'${s}'`).join(", ");
/** SQL fragment (prefix the column with table alias `m`) keeping only real, live messages. */
export const SIGNAL_FILTER = `m.deleted_at IS NULL AND (m.subtype IS NULL OR m.subtype NOT IN (${NOISE_LIST}))`;

// ---- Types ----

export interface Workspace {
  id: string;
  name: string;
  domain: string | null;
  synced_at: number | null;
}

export interface Channel {
  id: string;
  workspace_id: string;
  name: string | null;
  is_private: number;
  is_archived: number;
  topic: string | null;
  purpose: string | null;
  member_count: number;
  created_at: number | null;
  synced_at: number | null;
  last_synced_ts: string | null;
}

export interface User {
  id: string;
  workspace_id: string;
  username: string | null;
  real_name: string | null;
  display_name: string | null;
  email: string | null;
  title: string | null;
  is_bot: number;
  is_deleted: number;
  avatar_url: string | null;
  synced_at: number | null;
}

export interface Message {
  id: string;
  workspace_id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  subtype: string | null;
  user_id: string | null;
  username: string | null;
  text: string | null;
  has_attachments: number;
  has_files: number;
  reactions: string | null;
  reply_count: number;
  reply_users: string | null;
  edited_ts: string | null;
  created_at: number | null;
  deleted_at: number | null;
  raw_json: string | null;
}

// ---- Upserts ----

export function upsertWorkspace(db: Database, w: Partial<Workspace> & { id: string; name: string }) {
  db.run(
    `INSERT INTO workspaces(id, name, domain, synced_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, domain=excluded.domain, synced_at=excluded.synced_at`,
    [w.id, w.name, w.domain ?? null, Math.floor(Date.now() / 1000)],
  );
}

export function upsertChannel(db: Database, ch: Omit<Channel, "synced_at">) {
  db.run(
    `INSERT INTO channels(id, workspace_id, name, is_private, is_archived, topic, purpose,
       member_count, created_at, synced_at, last_synced_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, is_private=excluded.is_private, is_archived=excluded.is_archived,
       topic=excluded.topic, purpose=excluded.purpose, member_count=excluded.member_count,
       created_at=excluded.created_at, synced_at=excluded.synced_at,
       last_synced_ts=COALESCE(last_synced_ts, excluded.last_synced_ts)`,
    [
      ch.id, ch.workspace_id, ch.name, ch.is_private, ch.is_archived,
      ch.topic, ch.purpose, ch.member_count, ch.created_at,
      Math.floor(Date.now() / 1000), ch.last_synced_ts,
    ],
  );
}

export function updateLastSyncedTs(db: Database, channelId: string, ts: string) {
  db.run("UPDATE channels SET last_synced_ts=? WHERE id=?", [ts, channelId]);
}

export function upsertUser(db: Database, u: Omit<User, "synced_at">) {
  db.run(
    `INSERT INTO users(id, workspace_id, username, real_name, display_name, email, title,
       is_bot, is_deleted, avatar_url, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username=excluded.username, real_name=excluded.real_name,
       display_name=excluded.display_name, email=excluded.email, title=excluded.title,
       is_bot=excluded.is_bot, is_deleted=excluded.is_deleted,
       avatar_url=excluded.avatar_url, synced_at=excluded.synced_at`,
    [
      u.id, u.workspace_id, u.username, u.real_name, u.display_name,
      u.email, u.title, u.is_bot, u.is_deleted, u.avatar_url,
      Math.floor(Date.now() / 1000),
    ],
  );
}

export function upsertMessage(db: Database, m: Message) {
  // Seeing a message again means it still exists in Slack — clear any tombstone.
  db.run(
    `INSERT INTO messages(id, workspace_id, channel_id, ts, thread_ts, subtype, user_id, username, text,
       has_attachments, has_files, reactions, reply_count, reply_users, edited_ts, created_at, deleted_at, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
       text=excluded.text, subtype=excluded.subtype, has_attachments=excluded.has_attachments,
       has_files=excluded.has_files, reactions=excluded.reactions, reply_count=excluded.reply_count,
       reply_users=excluded.reply_users, edited_ts=excluded.edited_ts, raw_json=excluded.raw_json,
       deleted_at=NULL`,
    [
      m.id, m.workspace_id, m.channel_id, m.ts, m.thread_ts, m.subtype, m.user_id, m.username, m.text,
      m.has_attachments, m.has_files, m.reactions, m.reply_count,
      m.reply_users, m.edited_ts, m.created_at, m.raw_json,
    ],
  );
}

// ---- Queries ----

export interface MessageFilter {
  workspaceId?: string;
  channelId?: string;
  channelName?: string;
  username?: string;
  since?: number; // unix ts
  until?: number;
  last?: number;
  limit?: number;
}

export function queryMessages(db: Database, f: MessageFilter): Message[] {
  const limit = f.last || f.limit || 100;
  const conds: string[] = ["m.deleted_at IS NULL"];
  const args: (string | number)[] = [];

  if (f.workspaceId) { conds.push("m.workspace_id = ?"); args.push(f.workspaceId); }
  if (f.channelId)   { conds.push("m.channel_id = ?");   args.push(f.channelId); }
  else if (f.channelName) { conds.push("(m.channel_id = ? OR c.name = ?)"); args.push(f.channelName, f.channelName); }
  if (f.username)    { conds.push("(m.username = ? OR u.username = ? OR u.display_name = ?)"); args.push(f.username, f.username, f.username); }
  if (f.since)       { conds.push("m.created_at >= ?");  args.push(f.since); }
  if (f.until)       { conds.push("m.created_at <= ?");  args.push(f.until); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  args.push(limit);

  return db.query<Message, (string | number)[]>(
    `SELECT m.* FROM messages m
     LEFT JOIN channels c ON m.channel_id = c.id
     LEFT JOIN users u ON m.user_id = u.id
     ${where} ORDER BY m.created_at DESC LIMIT ?`,
  ).all(...args);
}

export function searchMessages(db: Database, query: string, f: Omit<MessageFilter, "last" | "until">): Message[] {
  const limit = f.limit || 50;
  const conds: string[] = ["messages_fts MATCH ?", SIGNAL_FILTER];
  const args: (string | number)[] = [query];

  if (f.workspaceId) { conds.push("m.workspace_id = ?"); args.push(f.workspaceId); }
  if (f.channelId)   { conds.push("m.channel_id = ?");   args.push(f.channelId); }
  else if (f.channelName) { conds.push("(m.channel_id = ? OR c.name = ?)"); args.push(f.channelName, f.channelName); }
  if (f.username)    { conds.push("(m.username = ? OR u.username = ? OR u.display_name = ?)"); args.push(f.username, f.username, f.username); }
  if (f.since)       { conds.push("m.created_at >= ?");  args.push(f.since); }

  args.push(limit);

  return db.query<Message, (string | number)[]>(
    `SELECT m.* FROM messages_fts
     JOIN messages m ON messages_fts.rowid = m.rowid
     LEFT JOIN channels c ON m.channel_id = c.id
     LEFT JOIN users u ON m.user_id = u.id
     WHERE ${conds.join(" AND ")}
     ORDER BY rank LIMIT ?`,
  ).all(...args);
}

export function getChannels(db: Database, workspaceId?: string, includeArchived = false): Channel[] {
  const conds: string[] = [];
  const args: string[] = [];
  if (workspaceId) { conds.push("workspace_id = ?"); args.push(workspaceId); }
  if (!includeArchived) conds.push("is_archived = 0");
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return db.query<Channel, string[]>(`SELECT * FROM channels ${where} ORDER BY name`).all(...args);
}

/**
 * Mark channels no longer in the active filter as archived, WITHOUT deleting their
 * history. The objective is "never lose context" — narrowing SLACKCRAWL_CHANNELS (or a
 * transient miss) must not destroy an archive. The rows just stop being synced.
 * Returns the names/ids that were deactivated.
 */
export function deactivateUnlistedChannels(db: Database, workspaceId: string, keepIds: string[]): string[] {
  if (keepIds.length === 0) return [];
  const placeholders = keepIds.map(() => "?").join(", ");
  const stale = db.query<{ id: string; name: string | null }, string[]>(
    `SELECT id, name FROM channels WHERE workspace_id = ? AND is_archived = 0 AND id NOT IN (${placeholders})`,
  ).all(workspaceId, ...keepIds);
  if (stale.length) {
    db.run(
      `UPDATE channels SET is_archived = 1 WHERE workspace_id = ? AND id NOT IN (${placeholders})`,
      [workspaceId, ...keepIds],
    );
  }
  return stale.map((c) => c.name ?? c.id);
}

export function getChannelByNameOrId(db: Database, workspaceId: string, nameOrId: string): Channel | null {
  return db.query<Channel, string[]>(
    "SELECT * FROM channels WHERE workspace_id = ? AND (id = ? OR name = ?) LIMIT 1",
  ).get(workspaceId, nameOrId, nameOrId);
}

export function getUsers(db: Database, workspaceId?: string, query?: string): User[] {
  const conds: string[] = [];
  const args: string[] = [];
  if (workspaceId) { conds.push("workspace_id = ?"); args.push(workspaceId); }
  if (query) {
    const q = `%${query}%`;
    conds.push("(username LIKE ? OR real_name LIKE ? OR display_name LIKE ? OR email LIKE ?)");
    args.push(q, q, q, q);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return db.query<User, string[]>(`SELECT * FROM users ${where} ORDER BY real_name`).all(...args);
}

export function getWorkspace(db: Database, id?: string): Workspace | null {
  if (id) return db.query<Workspace, [string]>("SELECT * FROM workspaces WHERE id = ?").get(id);
  return db.query<Workspace, []>("SELECT * FROM workspaces LIMIT 1").get();
}

export function getStats(db: Database) {
  const count = (table: string) =>
    (db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM ${table}`).get()?.n ?? 0);
  const pageCount = Number((db.query("PRAGMA page_count").get() as Record<string, unknown>)?.page_count ?? 0);
  const pageSize  = Number((db.query("PRAGMA page_size").get() as Record<string, unknown>)?.page_size ?? 4096);
  return {
    workspaces: count("workspaces"),
    channels:   count("channels"),
    users:      count("users"),
    messages:   count("messages"),
    dbSizeBytes: pageCount * pageSize,
  };
}

export interface ThreadContext {
  thread_ts: string;
  channel_id: string;
  root: Message | null;
  replies: Message[];
}

export function getThread(db: Database, channelId: string, threadTs: string): Message[] {
  return db.query<Message, [string, string, string]>(
    "SELECT * FROM messages WHERE channel_id = ? AND (ts = ? OR thread_ts = ?) AND deleted_at IS NULL ORDER BY created_at ASC",
  ).all(channelId, threadTs, threadTs);
}

export function expandThreads(db: Database, messages: Message[]): ThreadContext[] {
  const seen = new Set<string>();
  const pairs: { channelId: string; threadTs: string }[] = [];

  for (const m of messages) {
    const tts = m.thread_ts ?? (m.reply_count > 0 ? m.ts : null);
    if (!tts) continue;
    const key = `${m.channel_id}:${tts}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push({ channelId: m.channel_id, threadTs: tts });
    }
  }

  return pairs.map(({ channelId, threadTs }) => {
    const all = getThread(db, channelId, threadTs);
    return {
      thread_ts: threadTs,
      channel_id: channelId,
      root: all.find(m => m.ts === threadTs) ?? null,
      replies: all.filter(m => m.ts !== threadTs),
    };
  });
}

// ---- Thread re-polling & reconciliation (data-completeness) ----

export interface ThreadRoot {
  channel_id: string;
  thread_ts: string;       // root ts
  stored_max_reply_ts: string | null; // newest reply (or root) we already have
}

/**
 * Active thread roots in a channel that may have accrued new replies recently.
 * Used every sync cycle to re-poll replies (only fetching newer than stored_max_reply_ts),
 * which fixes the bug where replies to threads outside the history window were lost.
 * `sinceUnix` bounds the work to threads with recent activity.
 */
export function getActiveThreadRoots(db: Database, channelId: string, sinceUnix: number): ThreadRoot[] {
  return db.query<ThreadRoot, [string, number, number]>(
    `SELECT m.channel_id, m.ts AS thread_ts,
            (SELECT MAX(r.ts) FROM messages r
              WHERE r.channel_id = m.channel_id AND (r.ts = m.ts OR r.thread_ts = m.ts)) AS stored_max_reply_ts
     FROM messages m
     WHERE m.channel_id = ? AND m.reply_count > 0 AND m.thread_ts IS NULL
       AND m.deleted_at IS NULL
       AND (m.created_at >= ? OR CAST(m.ts AS REAL) >= ?)`,
  ).all(channelId, sinceUnix, sinceUnix);
}

/** Every thread root in a channel (used by full reconciliation). */
export function getAllThreadRoots(db: Database, channelId: string): ThreadRoot[] {
  return db.query<ThreadRoot, [string]>(
    `SELECT m.channel_id, m.ts AS thread_ts,
            (SELECT MAX(r.ts) FROM messages r
              WHERE r.channel_id = m.channel_id AND (r.ts = m.ts OR r.thread_ts = m.ts)) AS stored_max_reply_ts
     FROM messages m
     WHERE m.channel_id = ? AND m.reply_count > 0 AND m.thread_ts IS NULL`,
  ).all(channelId);
}

/** All non-deleted message ids currently stored for a channel (for deletion detection). */
export function getStoredMessageIds(db: Database, channelId: string): string[] {
  return db.query<{ id: string }, [string]>(
    "SELECT id FROM messages WHERE channel_id = ? AND deleted_at IS NULL",
  ).all(channelId).map((r) => r.id);
}

/** Tombstone messages that are no longer present in Slack (reconciliation). */
export function markMessagesDeleted(db: Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction((batch: string[]) => {
    const stmt = db.query("UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL");
    for (const id of batch) stmt.run(now, id);
  });
  tx(ids);
  return ids.length;
}
