// Route handlers for enrichment API endpoints.

import type { Database } from "bun:sqlite";
import type { Message } from "./db";
import { getChannelByNameOrId, getThread, searchMessages } from "./db";
import { type EnrichApiDeps, getQueryEmbedding } from "./enrich-api-shared";
import { int, json, parseSince } from "./util";

export type { EnrichApiDeps };

import { getChannelDigests, getThreadSummary, queryDecisions } from "./enrich-db";

export { handleContext } from "./enrich-api-context";

// ---- Types ----

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
      limit: int(p.get("limit"), 50, deps.maxLimit),
    });

    return json({ decisions, total: decisions.length });
  } catch {
    return json(
      {
        error: "Invalid search query. Avoid special characters like *, OR, NOT, NEAR.",
      },
      400,
    );
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
  const limit = int(p.get("limit"), 20, deps.maxLimit);

  if (userId) {
    const row = deps.db
      .query<
        {
          user_id: string;
          expertise: string | null;
          summary: string | null;
          updated_at: number;
          username: string | null;
          real_name: string | null;
        },
        [string]
      >(
        `SELECT up.*, u.username, u.real_name FROM user_profiles up
       LEFT JOIN users u ON up.user_id = u.id
       WHERE up.user_id = ?`,
      )
      .get(userId);
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
    const results = deps.db
      .query<
        {
          user_id: string;
          expertise: string | null;
          summary: string | null;
          updated_at: number;
          username: string | null;
          real_name: string | null;
        },
        [string, number]
      >(
        `SELECT up.*, u.username, u.real_name FROM user_profiles_fts
       JOIN user_profiles up ON user_profiles_fts.rowid = up.rowid
       LEFT JOIN users u ON up.user_id = u.id
       WHERE user_profiles_fts MATCH ?
       ORDER BY rank LIMIT ?`,
      )
      .all(query, limit);

    const experts = results.map((r) => ({
      ...r,
      expertise: r.expertise ? JSON.parse(r.expertise) : [],
    }));

    return json({ experts, total: experts.length });
  } catch {
    return json({ experts: [], total: 0 });
  }
}

export async function handleEnhancedSearch(deps: EnrichApiDeps, url: URL): Promise<Response> {
  const p = url.searchParams;
  const q = p.get("q");
  if (!q) return json({ error: "q is required" }, 400);

  const mode = p.get("mode") ?? "keyword";
  const limit = int(p.get("limit"), 50, deps.maxLimit);
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
        return json(
          {
            error: "Invalid search query. Avoid special characters like *, OR, NOT, NEAR.",
          },
          400,
        );
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
        const args: string[] = [...ids, deps.workspaceId, ...(channelId ? [channelId] : [])];
        const rows = deps.db
          .query<Message, string[]>(
            `SELECT m.* FROM messages m
               WHERE m.id IN (${placeholders}) AND m.deleted_at IS NULL AND m.workspace_id = ?
               ${channelId ? "AND m.channel_id = ?" : ""}`,
          )
          .all(...args);

        semanticMessages = rows
          .map((m) => ({ ...m, score: scoreMap.get(m.id) ?? 0 }))
          .sort((a, b) => b.score - a.score);
      }
    } catch (err) {
      console.error("[search] semantic search failed:", err);
    }
  }

  if (mode === "semantic") {
    return json({
      messages: semanticMessages,
      total: semanticMessages.length,
      mode,
    });
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

    const threads =
      p.get("include_threads") === "true" ? expandThreadsWithSummaries(deps.db, merged) : undefined;

    return json({
      messages: merged.slice(0, limit),
      total: merged.length,
      mode,
      ...(threads ? { threads } : {}),
    });
  }

  // Default keyword mode — add thread summaries if requested
  const threads =
    p.get("include_threads") === "true"
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
  const results: {
    thread_ts: string;
    channel_id: string;
    root: Message | null;
    replies: Message[];
    summary?: string;
  }[] = [];

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
