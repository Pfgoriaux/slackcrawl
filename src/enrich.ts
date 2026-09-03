// Enrichment pipeline orchestrator.
// Runs after each sync: embeddings → summaries → decisions → digests → profiles.

import type { Database } from "bun:sqlite";
import type { ClaudeClient, EmbeddingClient } from "./ai";
import type { Config } from "./config";
import type { Message } from "./db";
import { getThread } from "./db";
import {
  deleteDecisionsByThread,
  getUnembeddedMessages,
  getUnsummarizedThreads,
  insertDecision,
  markEnriched,
  upsertEmbedding,
  upsertThreadSummary,
} from "./enrich-db";
import { parseJSON } from "./enrich-helpers";
import { enrichChannelDigests, enrichUserProfiles } from "./enrich-stages";

export interface EnrichResult {
  embeddings: number;
  summaries: number;
  decisions: number;
  digests: number;
  profiles: number;
}

export async function runEnrichment(
  db: Database,
  cfg: Config,
  claude: ClaudeClient,
  embedder: EmbeddingClient,
): Promise<EnrichResult> {
  console.log("[enrich] starting enrichment pipeline");
  const result: EnrichResult = {
    embeddings: 0,
    summaries: 0,
    decisions: 0,
    digests: 0,
    profiles: 0,
  };

  // Stage 1: Embeddings
  result.embeddings = await enrichEmbeddings(db, cfg, embedder);

  // Stage 2: Thread summaries
  result.summaries = await enrichThreadSummaries(db, cfg, claude);

  // Stage 3: Decision extraction (runs on new summaries)
  result.decisions = await enrichDecisions(db, cfg, claude);

  // Stage 4: Channel digests
  result.digests = await enrichChannelDigests(db, cfg, claude);

  // Stage 5: User profiles (once per day)
  result.profiles = await enrichUserProfiles(db, cfg, claude);

  console.log(
    `[enrich] done: ${result.embeddings} embeddings, ${result.summaries} summaries, ${result.decisions} decisions, ${result.digests} digests, ${result.profiles} profiles`,
  );
  return result;
}

// ---- Stage 1: Embeddings ----

async function enrichEmbeddings(
  db: Database,
  cfg: Config,
  embedder: EmbeddingClient,
): Promise<number> {
  let total = 0;
  const batchSize = cfg.enrichBatch;
  const maxPerCycle = cfg.enrichMaxPerCycle;

  while (total < maxPerCycle) {
    const batch = getUnembeddedMessages(db, Math.min(batchSize, maxPerCycle - total));
    if (batch.length === 0) break;

    // Truncate long texts for embedding (8K tokens ≈ 32K chars max)
    const texts = batch.map((m) => (m.text.length > 32000 ? m.text.slice(0, 32000) : m.text));

    try {
      const embeddings = await embedder.embed(texts);
      for (let i = 0; i < batch.length; i++) {
        upsertEmbedding(db, batch[i].id, embeddings[i], cfg.embeddingModel);
      }
      total += batch.length;
      console.log(`[enrich] embedded ${total} messages`);
    } catch (err) {
      console.error(`[enrich] embedding batch failed:`, err);
      break;
    }

    if (batch.length < batchSize) break;
  }

  return total;
}

// ---- Stage 2: Thread Summaries ----

async function enrichThreadSummaries(
  db: Database,
  cfg: Config,
  claude: ClaudeClient,
): Promise<number> {
  const threads = getUnsummarizedThreads(db, cfg.enrichMinReplies, cfg.enrichMaxPerCycle);
  if (threads.length === 0) return 0;

  console.log(`[enrich] ${threads.length} threads to summarize`);
  let count = 0;

  for (const t of threads) {
    try {
      const messages = getThread(db, t.channel_id, t.thread_ts);
      if (messages.length < cfg.enrichMinReplies + 1) continue;

      const threadText = formatThread(messages);
      const participants = [...new Set(messages.map((m) => m.username).filter(Boolean))];

      const { text, inputTokens, outputTokens } = await claude.complete(
        threadText,
        `You are a Slack thread summarizer. Summarize this thread in 2-3 concise sentences.
Focus on: what was discussed, what was decided/concluded, and any action items.
Include participant names when relevant. Return ONLY the summary, no preamble.`,
      );

      upsertThreadSummary(db, {
        channel_id: t.channel_id,
        thread_ts: t.thread_ts,
        summary: text.trim(),
        participants: JSON.stringify(participants),
        message_count: messages.length,
        last_reply_ts: t.last_reply_ts,
      });
      markEnriched(
        db,
        "thread_summary",
        `${t.channel_id}:${t.thread_ts}`,
        cfg.claudeModel,
        inputTokens + outputTokens,
      );
      count++;

      if (count % 10 === 0) console.log(`[enrich] summarized ${count}/${threads.length} threads`);
    } catch (err) {
      console.error(`[enrich] thread summary failed (${t.channel_id}:${t.thread_ts}):`, err);
    }
  }

  return count;
}

// ---- Stage 3: Decision Extraction ----

async function enrichDecisions(db: Database, cfg: Config, claude: ClaudeClient): Promise<number> {
  // Find thread summaries that haven't had decisions extracted yet, or whose summary
  // was regenerated (new replies) since the last extraction — otherwise the decisions
  // table would silently contradict the current summary forever.
  const rows = db
    .query<{ channel_id: string; thread_ts: string; summary: string }, [number]>(`
    SELECT ts.channel_id, ts.thread_ts, ts.summary
    FROM thread_summaries ts
    WHERE NOT EXISTS (
      SELECT 1 FROM enrichment_log e
      WHERE e.entity_type = 'decisions' AND e.entity_id = ts.channel_id || ':' || ts.thread_ts
        AND e.created_at >= ts.created_at
    )
    ORDER BY ts.created_at DESC
    LIMIT ?
  `)
    .all(cfg.enrichMaxPerCycle);

  if (rows.length === 0) return 0;
  console.log(`[enrich] ${rows.length} threads for decision extraction`);

  let count = 0;
  for (const row of rows) {
    try {
      const { text, inputTokens, outputTokens } = await claude.complete(
        `Thread summary:\n${row.summary}`,
        `Extract decisions, action items, conclusions, and commitments from this thread summary.
Return a JSON array of objects with these fields:
- "decision": the text of the decision/action item
- "category": one of "decision", "action_item", "conclusion", "commitment"
- "participants": array of names involved

If there are no decisions or action items, return an empty array [].
Return ONLY valid JSON, no markdown fences, no explanation.`,
      );

      const decisions = parseJSON<
        { decision: string; category: string; participants?: string[] }[]
      >(text.trim(), []);

      // Re-extraction from an updated summary replaces, never duplicates.
      deleteDecisionsByThread(db, row.channel_id, row.thread_ts);

      for (const d of decisions) {
        if (!d.decision || !d.category) continue;
        const validCategories = ["decision", "action_item", "conclusion", "commitment"];
        const category = validCategories.includes(d.category) ? d.category : "conclusion";

        insertDecision(db, {
          channel_id: row.channel_id,
          thread_ts: row.thread_ts,
          decision: d.decision,
          category,
          participants: d.participants ? JSON.stringify(d.participants) : null,
          decided_at: Math.floor(parseFloat(row.thread_ts)),
        });
        count++;
      }

      markEnriched(
        db,
        "decisions",
        `${row.channel_id}:${row.thread_ts}`,
        cfg.claudeModel,
        inputTokens + outputTokens,
      );
    } catch (err) {
      console.error(
        `[enrich] decision extraction failed (${row.channel_id}:${row.thread_ts}):`,
        err,
      );
    }
  }

  return count;
}

// ---- Helpers ----

function formatThread(messages: Message[]): string {
  return messages.map((m) => `[${m.username ?? "unknown"}] ${m.text ?? ""}`).join("\n");
}
