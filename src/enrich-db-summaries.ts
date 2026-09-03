import type { Database } from "bun:sqlite";
import { SIGNAL_FILTER } from "./db-noise";

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

export function getThreadSummary(
  db: Database,
  channelId: string,
  threadTs: string,
): ThreadSummary | null {
  return db
    .query<ThreadSummary, [string, string]>(
      "SELECT * FROM thread_summaries WHERE channel_id = ? AND thread_ts = ?",
    )
    .get(channelId, threadTs);
}

export function getThreadSummaries(
  db: Database,
  channelId: string,
  since?: number,
): ThreadSummary[] {
  if (since) {
    return db
      .query<ThreadSummary, [string, number]>(
        "SELECT * FROM thread_summaries WHERE channel_id = ? AND created_at >= ? ORDER BY thread_ts DESC",
      )
      .all(channelId, since);
  }
  return db
    .query<ThreadSummary, [string]>(
      "SELECT * FROM thread_summaries WHERE channel_id = ? ORDER BY thread_ts DESC",
    )
    .all(channelId);
}

/** Find threads that need summarization: 2+ replies, no summary or stale summary */
export function getUnsummarizedThreads(
  db: Database,
  minReplies: number,
  limit = 500,
): {
  channel_id: string;
  thread_ts: string;
  reply_count: number;
  last_reply_ts: string;
}[] {
  return db
    .query<
      {
        channel_id: string;
        thread_ts: string;
        reply_count: number;
        last_reply_ts: string;
      },
      [number, number]
    >(`
    SELECT m.channel_id, m.ts as thread_ts, m.reply_count,
           (SELECT MAX(r.ts) FROM messages r WHERE r.channel_id = m.channel_id AND r.thread_ts = m.ts) as last_reply_ts
    FROM messages m
    WHERE m.reply_count >= ?
      AND m.thread_ts IS NULL
      AND ${SIGNAL_FILTER}
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
    LIMIT ?
  `)
    .all(minReplies, limit);
}
