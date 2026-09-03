import type { Database } from "bun:sqlite";
import type { Channel, Message, User, Workspace } from "./db-types";

// ---- Upserts ----

export function upsertWorkspace(
  db: Database,
  w: Partial<Workspace> & { id: string; name: string },
) {
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
      ch.id,
      ch.workspace_id,
      ch.name,
      ch.is_private,
      ch.is_archived,
      ch.topic,
      ch.purpose,
      ch.member_count,
      ch.created_at,
      Math.floor(Date.now() / 1000),
      ch.last_synced_ts,
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
      u.id,
      u.workspace_id,
      u.username,
      u.real_name,
      u.display_name,
      u.email,
      u.title,
      u.is_bot,
      u.is_deleted,
      u.avatar_url,
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
      m.id,
      m.workspace_id,
      m.channel_id,
      m.ts,
      m.thread_ts,
      m.subtype,
      m.user_id,
      m.username,
      m.text,
      m.has_attachments,
      m.has_files,
      m.reactions,
      m.reply_count,
      m.reply_users,
      m.edited_ts,
      m.created_at,
      m.raw_json,
    ],
  );
}

export function deactivateUnlistedChannels(
  db: Database,
  workspaceId: string,
  keepIds: string[],
): string[] {
  if (keepIds.length === 0) return [];
  const placeholders = keepIds.map(() => "?").join(", ");
  const stale = db
    .query<{ id: string; name: string | null }, string[]>(
      `SELECT id, name FROM channels WHERE workspace_id = ? AND is_archived = 0 AND id NOT IN (${placeholders})`,
    )
    .all(workspaceId, ...keepIds);
  if (stale.length) {
    db.run(
      `UPDATE channels SET is_archived = 1 WHERE workspace_id = ? AND id NOT IN (${placeholders})`,
      [workspaceId, ...keepIds],
    );
  }
  return stale.map((c) => c.name ?? c.id);
}

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
