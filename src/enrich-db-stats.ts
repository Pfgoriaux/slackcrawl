import type { Database } from "bun:sqlite";

// ---- Stats ----

export function getEnrichmentStats(db: Database) {
  const count = (table: string) =>
    db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM ${table}`).get()?.n ?? 0;
  return {
    thread_summaries: count("thread_summaries"),
    decisions: count("decisions"),
    channel_digests: count("channel_digests"),
    message_embeddings: count("message_embeddings"),
    user_profiles: count("user_profiles"),
    enrichment_log: count("enrichment_log"),
  };
}
