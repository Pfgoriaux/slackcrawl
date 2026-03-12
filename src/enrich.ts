// Enrichment pipeline orchestrator.
// Runs after each sync: embeddings → summaries → decisions → digests → profiles.

import type { Database } from "bun:sqlite";
import type { Config } from "./config";
import type { ClaudeClient, EmbeddingClient } from "./ai";
import type { Message } from "./db";
import { getThread, getChannels, queryMessages } from "./db";
import {
  getUnembeddedMessages, upsertEmbedding, markEnriched,
  getUnsummarizedThreads, upsertThreadSummary, getThreadSummary,
  insertDecision, getDecisionsByThread,
  getUndigestedDates, upsertChannelDigest, getThreadSummaries,
  getUsersNeedingProfiles, upsertUserProfile,
} from "./enrich-db";

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
  const result: EnrichResult = { embeddings: 0, summaries: 0, decisions: 0, digests: 0, profiles: 0 };

  // Stage 1: Embeddings
  result.embeddings = await enrichEmbeddings(db, cfg, embedder);

  // Stage 2: Thread summaries
  result.summaries = await enrichThreadSummaries(db, cfg, claude);

  // Stage 3: Decision extraction (runs on new summaries)
  result.decisions = await enrichDecisions(db, claude);

  // Stage 4: Channel digests
  result.digests = await enrichChannelDigests(db, cfg, claude);

  // Stage 5: User profiles (once per day)
  result.profiles = await enrichUserProfiles(db, claude);

  console.log(`[enrich] done: ${result.embeddings} embeddings, ${result.summaries} summaries, ${result.decisions} decisions, ${result.digests} digests, ${result.profiles} profiles`);
  return result;
}

// ---- Stage 1: Embeddings ----

async function enrichEmbeddings(db: Database, cfg: Config, embedder: EmbeddingClient): Promise<number> {
  let total = 0;
  const batchSize = cfg.enrichBatch;

  while (true) {
    const batch = getUnembeddedMessages(db, batchSize);
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

async function enrichThreadSummaries(db: Database, cfg: Config, claude: ClaudeClient): Promise<number> {
  const threads = getUnsummarizedThreads(db, cfg.enrichMinReplies);
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
      markEnriched(db, "thread_summary", `${t.channel_id}:${t.thread_ts}`, cfg.claudeModel, inputTokens + outputTokens);
      count++;

      if (count % 10 === 0) console.log(`[enrich] summarized ${count}/${threads.length} threads`);
    } catch (err) {
      console.error(`[enrich] thread summary failed (${t.channel_id}:${t.thread_ts}):`, err);
    }
  }

  return count;
}

// ---- Stage 3: Decision Extraction ----

async function enrichDecisions(db: Database, claude: ClaudeClient): Promise<number> {
  // Find thread summaries that haven't had decisions extracted yet
  const rows = db.query<{ channel_id: string; thread_ts: string; summary: string }, []>(`
    SELECT ts.channel_id, ts.thread_ts, ts.summary
    FROM thread_summaries ts
    WHERE NOT EXISTS (
      SELECT 1 FROM enrichment_log e
      WHERE e.entity_type = 'decisions' AND e.entity_id = ts.channel_id || ':' || ts.thread_ts
    )
    ORDER BY ts.created_at DESC
  `).all();

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

      const decisions = parseJSON<{ decision: string; category: string; participants?: string[] }[]>(text.trim(), []);

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

      markEnriched(db, "decisions", `${row.channel_id}:${row.thread_ts}`, "claude", inputTokens + outputTokens);
    } catch (err) {
      console.error(`[enrich] decision extraction failed (${row.channel_id}:${row.thread_ts}):`, err);
    }
  }

  return count;
}

// ---- Stage 4: Channel Digests ----

async function enrichChannelDigests(db: Database, cfg: Config, claude: ClaudeClient): Promise<number> {
  const undigested = getUndigestedDates(db);
  if (undigested.length === 0) return 0;

  console.log(`[enrich] ${undigested.length} channel-dates to digest`);
  let count = 0;

  for (const { channel_id, date, msg_count } of undigested) {
    try {
      const dayStart = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000);
      const dayEnd = dayStart + 86400;

      const messages = queryMessages(db, {
        channelId: channel_id,
        since: dayStart,
        until: dayEnd,
        limit: 200,
      });

      if (messages.length < 3) continue;

      // Gather any existing thread summaries for context
      const summaries = getThreadSummaries(db, channel_id, dayStart);
      const summaryContext = summaries.length > 0
        ? `\n\nThread summaries from this day:\n${summaries.map((s) => `- ${s.summary}`).join("\n")}`
        : "";

      const msgText = messages
        .map((m) => `[${m.username ?? "unknown"}] ${m.text ?? ""}`)
        .join("\n");

      const participants = new Set(messages.map((m) => m.username).filter(Boolean));
      const threadCount = new Set(messages.filter((m) => m.thread_ts).map((m) => m.thread_ts)).size;

      const { text, inputTokens, outputTokens } = await claude.complete(
        `Channel messages for ${date}:\n${msgText}${summaryContext}`,
        `You are creating a daily digest for a Slack channel. Summarize the day's activity in markdown format.
Include:
- Key topics discussed
- Important decisions or conclusions
- Notable threads

Return the summary in markdown (2-4 paragraphs). Also extract 3-8 key topic tags.
Format: first the markdown summary, then on a new line "TOPICS:" followed by comma-separated tags.`,
      );

      const [summary, topicLine] = splitTopics(text.trim());
      const keyTopics = topicLine
        ? topicLine.split(",").map((t) => t.trim()).filter(Boolean)
        : [];

      upsertChannelDigest(db, {
        channel_id,
        date,
        summary,
        key_topics: JSON.stringify(keyTopics),
        message_count: msg_count,
        thread_count: threadCount,
        participant_count: participants.size,
      });
      markEnriched(db, "digest", `${channel_id}:${date}`, cfg.claudeModel, inputTokens + outputTokens);
      count++;
    } catch (err) {
      console.error(`[enrich] digest failed (${channel_id}:${date}):`, err);
    }
  }

  return count;
}

// ---- Stage 5: User Profiles ----

async function enrichUserProfiles(db: Database, claude: ClaudeClient): Promise<number> {
  const users = getUsersNeedingProfiles(db);
  if (users.length === 0) return 0;

  console.log(`[enrich] ${users.length} user profiles to generate`);
  let count = 0;

  for (const user of users) {
    try {
      // Get recent messages for this user
      const messages = queryMessages(db, {
        username: user.username,
        limit: 100,
      });

      if (messages.length < 5) continue;

      // Get channels they're active in
      const channelIds = [...new Set(messages.map((m) => m.channel_id))];
      const channels = getChannels(db);
      const channelNames = channelIds
        .map((id) => channels.find((c) => c.id === id)?.name)
        .filter(Boolean);

      const msgSample = messages
        .slice(0, 50)
        .map((m) => `[#${channels.find((c) => c.id === m.channel_id)?.name ?? m.channel_id}] ${m.text ?? ""}`)
        .join("\n");

      const { text, inputTokens, outputTokens } = await claude.complete(
        `User: ${user.username}\nActive channels: ${channelNames.join(", ")}\n\nRecent messages:\n${msgSample}`,
        `Analyze this Slack user's messages and create an expertise profile.
Return JSON with:
- "expertise": array of {topic: string, confidence: number (0-1), channels: string[]}
- "summary": 1-2 sentence description of their role/expertise

Return ONLY valid JSON, no markdown fences. Max 10 expertise items.`,
      );

      const profile = parseJSON<{ expertise: unknown[]; summary: string }>(text.trim(), { expertise: [], summary: "" });

      upsertUserProfile(db, {
        user_id: user.user_id,
        expertise: JSON.stringify(profile.expertise),
        summary: profile.summary || null,
      });
      markEnriched(db, "user_profile", user.user_id, "claude", inputTokens + outputTokens);
      count++;
    } catch (err) {
      console.error(`[enrich] user profile failed (${user.user_id}):`, err);
    }
  }

  return count;
}

// ---- Helpers ----

function formatThread(messages: Message[]): string {
  return messages
    .map((m) => `[${m.username ?? "unknown"}] ${m.text ?? ""}`)
    .join("\n");
}

function parseJSON<T>(text: string, fallback: T): T {
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "");
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

function splitTopics(text: string): [string, string] {
  const idx = text.lastIndexOf("TOPICS:");
  if (idx === -1) return [text, ""];
  return [text.slice(0, idx).trim(), text.slice(idx + 7).trim()];
}
