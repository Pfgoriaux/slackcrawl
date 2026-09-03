import type { Database } from "bun:sqlite";
import { SIGNAL_FILTER } from "./db-noise";

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
    [
      d.channel_id,
      d.date,
      d.summary,
      d.key_topics,
      d.message_count,
      d.thread_count,
      d.participant_count,
    ],
  );
}

export function getChannelDigests(
  db: Database,
  opts: {
    channelId?: string;
    channelName?: string;
    date?: string;
    days?: number;
  },
): ChannelDigest[] {
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (opts.channelId) {
    conds.push("d.channel_id = ?");
    args.push(opts.channelId);
  } else if (opts.channelName) {
    conds.push("(d.channel_id = ? OR c.name = ?)");
    args.push(opts.channelName, opts.channelName);
  }
  if (opts.date) {
    conds.push("d.date = ?");
    args.push(opts.date);
  } else if (opts.days) {
    const since = new Date();
    since.setDate(since.getDate() - opts.days);
    conds.push("d.date >= ?");
    args.push(since.toISOString().slice(0, 10));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return db
    .query<ChannelDigest, (string | number)[]>(
      `SELECT d.* FROM channel_digests d
     LEFT JOIN channels c ON d.channel_id = c.id
     ${where} ORDER BY d.date DESC`,
    )
    .all(...args);
}

/** Find dates with messages but no digest */
export function getUndigestedDates(
  db: Database,
  limit = 500,
): { channel_id: string; date: string; msg_count: number }[] {
  return db
    .query<{ channel_id: string; date: string; msg_count: number }, [number]>(`
    SELECT m.channel_id, DATE(m.created_at, 'unixepoch') as date, COUNT(*) as msg_count
    FROM messages m
    WHERE m.thread_ts IS NULL
      AND ${SIGNAL_FILTER}
      AND NOT EXISTS (
        SELECT 1 FROM channel_digests cd
        WHERE cd.channel_id = m.channel_id AND cd.date = DATE(m.created_at, 'unixepoch')
      )
      AND DATE(m.created_at, 'unixepoch') < DATE('now')
    GROUP BY m.channel_id, date
    HAVING msg_count >= 3
    ORDER BY date DESC
    LIMIT ?
  `)
    .all(limit);
}
