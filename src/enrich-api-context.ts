// /v1/context — the main endpoint for agents: semantic + keyword search,
// thread summaries, decisions, digests and expert matches in one call.
// Split out of enrich-api.ts to respect the file-size convention.

import { getChannelByNameOrId, type Message, searchMessages } from "./db";
import type { EnrichApiDeps } from "./enrich-api-shared";
import { getQueryEmbedding } from "./enrich-api-shared";
import { getChannelDigests, getThreadSummary, queryDecisions } from "./enrich-db";
import { int, isFtsQueryError, json } from "./util";

export async function handleContext(deps: EnrichApiDeps, url: URL): Promise<Response> {
  const p = url.searchParams;
  const topic = p.get("topic");
  if (!topic) return json({ error: "topic is required" }, 400);

  const channelParam = p.get("channel");
  const days = int(p.get("days"), 14, 3650);
  const limit = int(p.get("limit"), 10, deps.maxLimit);
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
        const args: string[] = [...ids, deps.workspaceId, ...(channelId ? [channelId] : [])];
        const rows = deps.db
          .query<Message, string[]>(
            `SELECT m.* FROM messages m
               WHERE m.id IN (${placeholders}) AND m.deleted_at IS NULL AND m.workspace_id = ?
               ${channelId ? "AND m.channel_id = ?" : ""}
               ORDER BY m.created_at DESC`,
          )
          .all(...args);

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
  } catch (err) {
    // FTS5 syntax error (user query had special operators) — fall back to empty;
    // other errors are noteworthy and get logged, not swallowed silently.
    if (!isFtsQueryError(err)) console.error("[context] keyword search failed:", err);
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
  } catch (err) {
    // FTS5 syntax error — skip decisions rather than fail the whole context call
    if (!isFtsQueryError(err)) console.error("[context] decisions query failed:", err);
  }

  // 6. Digests for the time window
  const digests = getChannelDigests(deps.db, {
    channelId,
    days,
  });

  // 7. Expert matches (JOIN users in SQL to avoid loading all users)
  let experts: {
    user_id: string;
    summary: string | null;
    username: string | null;
  }[] = [];
  try {
    experts = deps.db
      .query<
        { user_id: string; summary: string | null; username: string | null },
        [string, number]
      >(
        `SELECT up.user_id, up.summary, u.username FROM user_profiles_fts
       JOIN user_profiles up ON user_profiles_fts.rowid = up.rowid
       LEFT JOIN users u ON up.user_id = u.id
       WHERE user_profiles_fts MATCH ?
       ORDER BY rank LIMIT ?`,
      )
      .all(topic, 5);
  } catch (err) {
    // FTS5 may fail if no profiles exist yet or query has special chars
    if (!isFtsQueryError(err)) console.error("[context] expertise query failed:", err);
  }

  // Estimate tokens (~4 chars per token)
  const contextJson = JSON.stringify({
    messages,
    threadSummaries,
    decisions,
    digests,
    experts,
  });
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
