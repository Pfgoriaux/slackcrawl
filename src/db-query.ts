import type { Database } from "bun:sqlite";
import { SIGNAL_FILTER } from "./db-noise";
import type { Channel, Message, User, Workspace } from "./db-types";

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

  if (f.workspaceId) {
    conds.push("m.workspace_id = ?");
    args.push(f.workspaceId);
  }
  if (f.channelId) {
    conds.push("m.channel_id = ?");
    args.push(f.channelId);
  } else if (f.channelName) {
    conds.push("(m.channel_id = ? OR c.name = ?)");
    args.push(f.channelName, f.channelName);
  }
  if (f.username) {
    conds.push("(m.username = ? OR u.username = ? OR u.display_name = ?)");
    args.push(f.username, f.username, f.username);
  }
  if (f.since) {
    conds.push("m.created_at >= ?");
    args.push(f.since);
  }
  if (f.until) {
    conds.push("m.created_at <= ?");
    args.push(f.until);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  args.push(limit);

  return db
    .query<Message, (string | number)[]>(
      `SELECT m.* FROM messages m
     LEFT JOIN channels c ON m.channel_id = c.id
     LEFT JOIN users u ON m.user_id = u.id
     ${where} ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(...args);
}

export function searchMessages(
  db: Database,
  query: string,
  f: Omit<MessageFilter, "last" | "until">,
): Message[] {
  const limit = f.limit || 50;
  const conds: string[] = ["messages_fts MATCH ?", SIGNAL_FILTER];
  const args: (string | number)[] = [query];

  if (f.workspaceId) {
    conds.push("m.workspace_id = ?");
    args.push(f.workspaceId);
  }
  if (f.channelId) {
    conds.push("m.channel_id = ?");
    args.push(f.channelId);
  } else if (f.channelName) {
    conds.push("(m.channel_id = ? OR c.name = ?)");
    args.push(f.channelName, f.channelName);
  }
  if (f.username) {
    conds.push("(m.username = ? OR u.username = ? OR u.display_name = ?)");
    args.push(f.username, f.username, f.username);
  }
  if (f.since) {
    conds.push("m.created_at >= ?");
    args.push(f.since);
  }

  args.push(limit);

  return db
    .query<Message, (string | number)[]>(
      `SELECT m.* FROM messages_fts
     JOIN messages m ON messages_fts.rowid = m.rowid
     LEFT JOIN channels c ON m.channel_id = c.id
     LEFT JOIN users u ON m.user_id = u.id
     WHERE ${conds.join(" AND ")}
     ORDER BY rank LIMIT ?`,
    )
    .all(...args);
}

export function getChannels(
  db: Database,
  workspaceId?: string,
  includeArchived = false,
): Channel[] {
  const conds: string[] = [];
  const args: string[] = [];
  if (workspaceId) {
    conds.push("workspace_id = ?");
    args.push(workspaceId);
  }
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

export function getChannelByNameOrId(
  db: Database,
  workspaceId: string,
  nameOrId: string,
): Channel | null {
  return db
    .query<Channel, string[]>(
      "SELECT * FROM channels WHERE workspace_id = ? AND (id = ? OR name = ?) LIMIT 1",
    )
    .get(workspaceId, nameOrId, nameOrId);
}

export function getUsers(db: Database, workspaceId?: string, query?: string): User[] {
  const conds: string[] = [];
  const args: string[] = [];
  if (workspaceId) {
    conds.push("workspace_id = ?");
    args.push(workspaceId);
  }
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
    db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM ${table}`).get()?.n ?? 0;
  const pageCount = Number(
    (db.query("PRAGMA page_count").get() as Record<string, unknown>)?.page_count ?? 0,
  );
  const pageSize = Number(
    (db.query("PRAGMA page_size").get() as Record<string, unknown>)?.page_size ?? 4096,
  );
  return {
    workspaces: count("workspaces"),
    channels: count("channels"),
    users: count("users"),
    messages: count("messages"),
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
  return db
    .query<Message, [string, string, string]>(
      "SELECT * FROM messages WHERE channel_id = ? AND (ts = ? OR thread_ts = ?) AND deleted_at IS NULL ORDER BY created_at ASC",
    )
    .all(channelId, threadTs, threadTs);
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
      root: all.find((m) => m.ts === threadTs) ?? null,
      replies: all.filter((m) => m.ts !== threadTs),
    };
  });
}

// ---- Thread re-polling & reconciliation (data-completeness) ----

export interface ThreadRoot {
  channel_id: string;
  thread_ts: string; // root ts
  stored_max_reply_ts: string | null; // newest reply (or root) we already have
}

/**
 * Active thread roots in a channel that may have accrued new replies recently.
 * Used every sync cycle to re-poll replies (only fetching newer than stored_max_reply_ts),
 * which fixes the bug where replies to threads outside the history window were lost.
 * `sinceUnix` bounds the work to threads with recent activity.
 */
export function getActiveThreadRoots(
  db: Database,
  channelId: string,
  sinceUnix: number,
): ThreadRoot[] {
  return db
    .query<ThreadRoot, [string, number, number]>(
      `SELECT m.channel_id, m.ts AS thread_ts,
            (SELECT MAX(r.ts) FROM messages r
              WHERE r.channel_id = m.channel_id AND (r.ts = m.ts OR r.thread_ts = m.ts)) AS stored_max_reply_ts
     FROM messages m
     WHERE m.channel_id = ? AND m.reply_count > 0 AND m.thread_ts IS NULL
       AND m.deleted_at IS NULL
       AND (m.created_at >= ? OR CAST(m.ts AS REAL) >= ?)`,
    )
    .all(channelId, sinceUnix, sinceUnix);
}

/** Every live thread root in a channel (used by full reconciliation). */
export function getAllThreadRoots(db: Database, channelId: string): ThreadRoot[] {
  return db
    .query<ThreadRoot, [string]>(
      `SELECT m.channel_id, m.ts AS thread_ts,
            (SELECT MAX(r.ts) FROM messages r
              WHERE r.channel_id = m.channel_id AND (r.ts = m.ts OR r.thread_ts = m.ts)) AS stored_max_reply_ts
     FROM messages m
     WHERE m.channel_id = ? AND m.reply_count > 0 AND m.thread_ts IS NULL
       AND m.deleted_at IS NULL`,
    )
    .all(channelId);
}

/** Ids of all live messages of one thread (root + replies) — used to tombstone dead threads. */
export function getThreadMessageIds(db: Database, channelId: string, threadTs: string): string[] {
  return db
    .query<{ id: string }, [string, string, string]>(
      "SELECT id FROM messages WHERE channel_id = ? AND (ts = ? OR thread_ts = ?) AND deleted_at IS NULL",
    )
    .all(channelId, threadTs, threadTs)
    .map((r) => r.id);
}

/** All non-deleted message ids currently stored for a channel (for deletion detection). */
export function getStoredMessageIds(db: Database, channelId: string): string[] {
  return db
    .query<{ id: string }, [string]>(
      "SELECT id FROM messages WHERE channel_id = ? AND deleted_at IS NULL",
    )
    .all(channelId)
    .map((r) => r.id);
}

/** Tombstone messages that are no longer present in Slack (reconciliation). */
