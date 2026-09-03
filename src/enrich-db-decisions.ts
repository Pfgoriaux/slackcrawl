import type { Database } from "bun:sqlite";

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

/** Remove all decisions for a thread (before re-extraction from an updated summary). */
export function deleteDecisionsByThread(db: Database, channelId: string, threadTs: string) {
  db.run("DELETE FROM decisions WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
}

export function getDecisionsByThread(
  db: Database,
  channelId: string,
  threadTs: string,
): Decision[] {
  return db
    .query<Decision, [string, string]>(
      "SELECT * FROM decisions WHERE channel_id = ? AND thread_ts = ? ORDER BY decided_at",
    )
    .all(channelId, threadTs);
}

export function queryDecisions(
  db: Database,
  opts: {
    channelId?: string;
    channelName?: string;
    since?: number;
    query?: string;
    category?: string;
    limit?: number;
  },
): Decision[] {
  const limit = opts.limit ?? 50;

  // FTS path
  if (opts.query) {
    const conds: string[] = ["decisions_fts MATCH ?"];
    const args: (string | number)[] = [opts.query];
    if (opts.channelId) {
      conds.push("d.channel_id = ?");
      args.push(opts.channelId);
    } else if (opts.channelName) {
      conds.push("(d.channel_id = ? OR c.name = ?)");
      args.push(opts.channelName, opts.channelName);
    }
    if (opts.since) {
      conds.push("d.decided_at >= ?");
      args.push(opts.since);
    }
    if (opts.category) {
      conds.push("d.category = ?");
      args.push(opts.category);
    }
    args.push(limit);
    return db
      .query<Decision, (string | number)[]>(
        `SELECT d.* FROM decisions_fts
       JOIN decisions d ON decisions_fts.rowid = d.id
       LEFT JOIN channels c ON d.channel_id = c.id
       WHERE ${conds.join(" AND ")}
       ORDER BY rank LIMIT ?`,
      )
      .all(...args);
  }

  // Non-FTS path
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (opts.channelId) {
    conds.push("d.channel_id = ?");
    args.push(opts.channelId);
  } else if (opts.channelName) {
    conds.push("(d.channel_id = ? OR c.name = ?)");
    args.push(opts.channelName, opts.channelName);
  }
  if (opts.since) {
    conds.push("d.decided_at >= ?");
    args.push(opts.since);
  }
  if (opts.category) {
    conds.push("d.category = ?");
    args.push(opts.category);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  args.push(limit);
  return db
    .query<Decision, (string | number)[]>(
      `SELECT d.* FROM decisions d
     LEFT JOIN channels c ON d.channel_id = c.id
     ${where} ORDER BY d.decided_at DESC LIMIT ?`,
    )
    .all(...args);
}
