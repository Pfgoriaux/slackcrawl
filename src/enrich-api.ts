// Route handlers for enrichment API endpoints.

import type { Database } from "bun:sqlite";
import type { EmbeddingClient } from "./ai";
import type { VecIndex } from "./vec";
import {
  queryDecisions, getChannelDigests,
  getThreadSummary,
} from "./enrich-db";
import { searchMessages, queryMessages, getChannelByNameOrId, getThread } from "./db";
import type { Message } from "./db";
import { json, int, parseSince } from "./util";

// ---- Types ----

export interface EnrichApiDeps {
  db: Database;
  workspaceId: string;
  vecIndex: VecIndex | null;
  embedder: EmbeddingClient | null;
}

// LRU cache for query embeddings
const embedCache = new Map<string, { embedding: Float32Array; ts: number }>();
const CACHE_MAX = 100;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

async function getQueryEmbedding(embedder: EmbeddingClient, text: string): Promise<Float32Array> {
  const cached = embedCache.get(text);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.embedding;

  const embedding = await embedder.embedOne(text);

  // Evict oldest if at capacity
  if (embedCache.size >= CACHE_MAX) {
    let oldest = "";
    let oldestTs = Infinity;
    for (const [k, v] of embedCache) {
      if (v.ts < oldestTs) { oldest = k; oldestTs = v.ts; }
    }
    if (oldest) embedCache.delete(oldest);
  }

  embedCache.set(text, { embedding, ts: Date.now() });
  return embedding;
}

// ---- Handlers ----

export function handleDecisions(deps: EnrichApiDeps, url: URL): Response {
  const p = url.searchParams;
  const channelParam = p.get("channel");

  let channelId: string | undefined;
  let channelName: string | undefined;
  if (channelParam) {
    const ch = getChannelByNameOrId(deps.db, deps.workspaceId, channelParam);
    if (ch) channelId = ch.id;
    else channelName = channelParam;
  }

  try {
    const decisions = queryDecisions(deps.db, {
      channelId,
      channelName,
      since: parseSince(p),
      query: p.get("q") ?? undefined,
      category: p.get("category") ?? undefined,
      limit: int(p.get("limit"), 50),
    });

    return json({ decisions, total: decisions.length });
  } catch {
    return json({ error: "Invalid search query. Avoid special characters like *, OR, NOT, NEAR." }, 400);
  }
}

export function handleDigests(deps: EnrichApiDeps, url: URL): Response {
  const p = url.searchParams;
  const channelParam = p.get("channel");

  let channelId: string | undefined;
  let channelName: string | undefined;
  if (channelParam) {
    const ch = getChannelByNameOrId(deps.db, deps.workspaceId, channelParam);
    if (ch) channelId = ch.id;
    else channelName = channelParam;
  }

  const digests = getChannelDigests(deps.db, {
    channelId,
    channelName,
    date: p.get("date") ?? undefined,
    days: int(p.get("days"), 7),
  });

  return json({ digests, total: digests.length });
}

export function handleExpertise(deps: EnrichApiDeps, url: URL): Response {
  const p = url.searchParams;
  const query = p.get("q");
  const userId = p.get("user");
  const limit = int(p.get("limit"), 20);

  if (userId) {
    const row = deps.db.query<
      { user_id: string; expertise: string | null; summary: string | null; updated_at: number; username: string | null; real_name: string | null },
      [string]
    >(
      `SELECT up.*, u.username, u.real_name FROM user_profiles up
       LEFT JOIN users u ON up.user_id = u.id
       WHERE up.user_id = ?`,
    ).get(userId);
    if (!row) return json({ error: "user profile not found" }, 404);

    return json({
      profile: {
        ...row,
        expertise: row.expertise ? JSON.parse(row.expertise) : [],
      },
    });
  }

  if (!query) return json({ error: "q or user is required" }, 400);

  try {
    const results = deps.db.query<
      { user_id: string; expertise: string | null; summary: string | null; updated_at: number; username: string | null; real_name: string | null },
      [string, number]
    >(
      `SELECT up.*, u.username, u.real_name FROM user_profiles_fts
       JOIN user_profiles up ON user_profiles_fts.rowid = up.rowid
       LEFT JOIN users u ON up.user_id = u.id
       WHERE user_profiles_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    ).all(query, limit);

    const experts = results.map((r) => ({
      ...r,
      expertise: r.expertise ? JSON.parse(r.expertise) : [],
    }));

    return json({ experts, total: experts.length });
  } catch {
    return json({ experts: [], total: 0 });
  }
}

export async function handleContext(deps: EnrichApiDeps, url: URL): Promise<Response> {
  const p = url.searchParams;
  const topic = p.get("topic");
  if (!topic) return json({ error: "topic is required" }, 400);

  const channelParam = p.get("channel");
  const days = int(p.get("days"), 14);
  const limit = int(p.get("limit"), 10);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  let channelId: string | undefined;
  if (channelParam) {
    const ch = getChannelByNameOrId(deps.db, deps.workspaceId, channelParam);
    if (ch) channelId = ch.id;
  }

  // 1. Semantic search (if available)
  let semanticMessages: (Message & { score?: number })[] = [];
  if (deps.vecIndex && deps.embedder && deps.vecIndex.size > 0) {
    try {
      const queryEmb = await getQueryEmbedding(deps.embedder, topic);
      const hits = deps.vecIndex.search(queryEmb, limit * 2);
      const ids = hits.map((h) => h.messageId);
      const scoreMap = new Map(hits.map((h) => [h.messageId, h.score]));

      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = deps.db.query<Message, string[]>(
          `SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
        ).all(...ids);

        semanticMessages = rows.map((m) => ({
          ...m,
          score: scoreMap.get(m.id),
        }));
      }
    } catch (err) {
      console.error("[context] semantic search failed:", err);
    }
  }

  // 2. Keyword search via FTS5
  let keywordMessages: Message[] = [];
  try {
    keywordMessages = searchMessages(deps.db, topic, {
      channelId,
      since,
      limit,
    });
  } catch {
    // FTS5 syntax error (user query had special operators) — fall back to empty
  }

  // 3. De-duplicate & merge
  const seen = new Set<string>();
  const allMessages: (Message & { score?: number; source?: string })[] = [];

  for (const m of semanticMessages) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      allMessages.push({ ...m, source: "semantic" });
    }
  }
  for (const m of keywordMessages) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      allMessages.push({ ...m, source: "keyword" });
    }
  }

  // Trim to limit
  const messages = allMessages.slice(0, limit);

  // 4. Fetch thread summaries for matched threads
  const threadSummaries: Record<string, string> = {};
  const threadKeys = new Set<string>();
  for (const m of messages) {
    const tts = m.thread_ts ?? (m.reply_count > 0 ? m.ts : null);
    if (tts) threadKeys.add(`${m.channel_id}:${tts}`);
  }
  for (const key of threadKeys) {
    const colonIdx = key.indexOf(":");
    const chId = key.slice(0, colonIdx);
    const tts = key.slice(colonIdx + 1);
    const summary = getThreadSummary(deps.db, chId, tts);
    if (summary) threadSummaries[key] = summary.summary;
  }

  // 5. Decisions for the time window
  let decisions: ReturnType<typeof queryDecisions> = [];
  try {
    decisions = queryDecisions(deps.db, {
      channelId,
      since,
      query: topic,
      limit: 20,
    });
  } catch {
    // FTS5 syntax error — skip decisions rather than fail the whole context call
  }

  // 6. Digests for the time window
  const digests = getChannelDigests(deps.db, {
    channelId,
    days,
  });

  // 7. Expert matches (JOIN users in SQL to avoid loading all users)
  let experts: { user_id: string; summary: string | null; username: string | null }[] = [];
  try {
    experts = deps.db.query<
      { user_id: string; summary: string | null; username: string | null },
      [string, number]
    >(
      `SELECT up.user_id, up.summary, u.username FROM user_profiles_fts
       JOIN user_profiles up ON user_profiles_fts.rowid = up.rowid
       LEFT JOIN users u ON up.user_id = u.id
       WHERE user_profiles_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    ).all(topic, 5);
  } catch {
    // FTS5 may fail if no profiles exist yet or query has special chars
  }

  // Estimate tokens (~4 chars per token)
  const contextJson = JSON.stringify({ messages, threadSummaries, decisions, digests, experts });
  const tokenEstimate = Math.ceil(contextJson.length / 4);

  return json({
    topic,
    messages,
    thread_summaries: threadSummaries,
    decisions,
    digests,
    experts,
    token_estimate: tokenEstimate,
    total_messages: messages.length,
  });
}

export async function handleEnhancedSearch(deps: EnrichApiDeps, url: URL): Promise<Response> {
  const p = url.searchParams;
  const q = p.get("q");
  if (!q) return json({ error: "q is required" }, 400);

  const mode = p.get("mode") ?? "keyword";
  const limit = int(p.get("limit"), 50);
  const channelParam = p.get("channel");

  let channelId: string | undefined;
  let channelName: string | undefined;
  if (channelParam) {
    const ch = getChannelByNameOrId(deps.db, deps.workspaceId, channelParam);
    if (ch) channelId = ch.id;
    else channelName = channelParam;
  }

  // Keyword results (always, for all modes)
  let keywordMessages: Message[] = [];
  if (mode !== "semantic") {
    try {
      keywordMessages = searchMessages(deps.db, q, {
        workspaceId: deps.workspaceId,
        channelId,
        channelName,
        username: p.get("author") ?? undefined,
        since: parseSince(p),
        limit,
      });
    } catch {
      // FTS5 syntax error — if keyword-only mode, return the error
      if (mode === "keyword") {
        return json({ error: "Invalid search query. Avoid special characters like *, OR, NOT, NEAR." }, 400);
      }
      // hybrid mode: fall through to semantic results
    }
  }

  // Semantic results
  let semanticMessages: (Message & { score: number })[] = [];
  if (mode !== "keyword" && deps.vecIndex && deps.embedder && deps.vecIndex.size > 0) {
    try {
      const queryEmb = await getQueryEmbedding(deps.embedder, q);
      const hits = deps.vecIndex.search(queryEmb, limit);
      const ids = hits.map((h) => h.messageId);
      const scoreMap = new Map(hits.map((h) => [h.messageId, h.score]));

      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = deps.db.query<Message, string[]>(
          `SELECT * FROM messages WHERE id IN (${placeholders})`,
        ).all(...ids);

        semanticMessages = rows
          .map((m) => ({ ...m, score: scoreMap.get(m.id) ?? 0 }))
          .sort((a, b) => b.score - a.score);
      }
    } catch (err) {
      console.error("[search] semantic search failed:", err);
    }
  }

  if (mode === "semantic") {
    return json({ messages: semanticMessages, total: semanticMessages.length, mode });
  }

  if (mode === "hybrid") {
    // Merge and deduplicate
    const seen = new Set<string>();
    const merged: (Message & { score?: number; source?: string })[] = [];

    for (const m of semanticMessages) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push({ ...m, source: "semantic" });
      }
    }
    for (const m of keywordMessages) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push({ ...m, source: "keyword" });
      }
    }

    const threads = p.get("include_threads") === "true"
      ? expandThreadsWithSummaries(deps.db, merged)
      : undefined;

    return json({
      messages: merged.slice(0, limit),
      total: merged.length,
      mode,
      ...(threads ? { threads } : {}),
    });
  }

  // Default keyword mode — add thread summaries if requested
  const threads = p.get("include_threads") === "true"
    ? expandThreadsWithSummaries(deps.db, keywordMessages)
    : undefined;

  return json({
    messages: keywordMessages,
    total: keywordMessages.length,
    mode: "keyword",
    ...(threads ? { threads } : {}),
  });
}

// ---- Helpers ----

function expandThreadsWithSummaries(db: Database, messages: Message[]) {
  const seen = new Set<string>();
  const results: { thread_ts: string; channel_id: string; root: Message | null; replies: Message[]; summary?: string }[] = [];

  for (const m of messages) {
    const tts = m.thread_ts ?? (m.reply_count > 0 ? m.ts : null);
    if (!tts) continue;
    const key = `${m.channel_id}:${tts}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const all = getThread(db, m.channel_id, tts);
    const summary = getThreadSummary(db, m.channel_id, tts);

    results.push({
      thread_ts: tts,
      channel_id: m.channel_id,
      root: all.find((msg) => msg.ts === tts) ?? null,
      replies: all.filter((msg) => msg.ts !== tts),
      ...(summary ? { summary: summary.summary } : {}),
    });
  }

  return results;
}

// json, int, parseSince imported from ./util
