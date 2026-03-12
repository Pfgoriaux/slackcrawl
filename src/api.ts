import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import {
  queryMessages, getChannels, getUsers,
  getWorkspace, getStats, execReadOnly, getThread, expandThreads,
  getChannelByNameOrId,
} from "./db";
import { getEnrichmentStats } from "./enrich-db";
import {
  handleDecisions, handleDigests, handleExpertise,
  handleContext, handleEnhancedSearch,
  type EnrichApiDeps,
} from "./enrich-api";
import type { VecIndex } from "./vec";
import type { EmbeddingClient } from "./ai";
import type { SyncOptions } from "./sync";

type SyncCallback = (opts: SyncOptions) => void;
type EnrichCallback = () => void;

export function createServer(
  db: Database,
  apiKey: string,
  workspaceId: string,
  onSync: SyncCallback,
  opts?: {
    vecIndex?: VecIndex | null;
    embedder?: EmbeddingClient | null;
    onEnrich?: EnrichCallback;
  },
) {
  const enrichDeps: EnrichApiDeps = {
    db,
    workspaceId,
    vecIndex: opts?.vecIndex ?? null,
    embedder: opts?.embedder ?? null,
  };
  return Bun.serve({
    port: parseInt(process.env.PORT ?? "8080"),
    hostname: process.env.SLACKCRAWL_HOST ?? "0.0.0.0",

    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Health — no auth required
      if (path === "/health") {
        return json({ status: "ok", time: new Date().toISOString() });
      }

      // Auth check for all /v1/* routes
      if (!checkAuth(req, apiKey)) {
        return json({ error: "unauthorized" }, 401);
      }

      // Router
      if (path === "/v1/search" && req.method === "GET") return handleEnhancedSearch(enrichDeps, url);
      if (path === "/v1/messages" && req.method === "GET") return handleMessages(db, workspaceId, url);
      if (path === "/v1/threads" && req.method === "GET") return handleThreads(db, workspaceId, url);
      if (path === "/v1/channels" && req.method === "GET") return handleChannels(db, workspaceId, url);
      if (path === "/v1/members" && req.method === "GET") return handleMembers(db, workspaceId, url);
      if (path === "/v1/status" && req.method === "GET") return handleStatus(db, workspaceId);
      if (path === "/v1/sync" && req.method === "POST") return handleSync(req, onSync);
      if (path === "/v1/sql" && req.method === "GET") return handleSQL(db, url);

      // Enrichment endpoints
      if (path === "/v1/decisions" && req.method === "GET") return handleDecisions(enrichDeps, url);
      if (path === "/v1/digests" && req.method === "GET") return handleDigests(enrichDeps, url);
      if (path === "/v1/expertise" && req.method === "GET") return handleExpertise(enrichDeps, url);
      if (path === "/v1/context" && req.method === "GET") return handleContext(enrichDeps, url);
      if (path === "/v1/enrich" && req.method === "POST") return handleEnrichTrigger(opts?.onEnrich);

      return json({ error: "not found" }, 404);
    },

    error(err) {
      console.error("[api] unhandled error:", err);
      return json({ error: "internal server error" }, 500);
    },
  });
}

// ---- Handlers ----

function handleMessages(db: Database, workspaceId: string, url: URL): Response {
  const p = url.searchParams;
  const hours = int(p.get("hours"), 0);
  const days  = int(p.get("days"), 0);

  let since = parseSince(p);
  if (!since && hours) since = Math.floor(Date.now() / 1000) - hours * 3600;
  if (!since && days)  since = Math.floor(Date.now() / 1000) - days * 86400;

  let until: number | undefined;
  const untilStr = p.get("until");
  if (untilStr) until = Math.floor(new Date(untilStr).getTime() / 1000);

  const messages = queryMessages(db, {
    workspaceId,
    channelName: p.get("channel") ?? undefined,
    username: p.get("author") ?? undefined,
    since,
    until,
    last: int(p.get("last"), 0) || undefined,
    limit: int(p.get("limit"), 100),
  });

  const threads = p.get("include_threads") === "true"
    ? expandThreads(db, messages)
    : undefined;

  return json({ messages, total: messages.length, channel: p.get("channel"), ...(threads ? { threads } : {}) });
}

function handleChannels(db: Database, workspaceId: string, url: URL): Response {
  const includeArchived = url.searchParams.get("archived") === "true";
  const channels = getChannels(db, workspaceId, includeArchived);
  return json({ channels, total: channels.length });
}

function handleMembers(db: Database, workspaceId: string, url: URL): Response {
  const query = url.searchParams.get("query") ?? undefined;
  const members = getUsers(db, workspaceId, query);
  return json({ members, total: members.length });
}

function handleStatus(db: Database, workspaceId: string): Response {
  const stats = getStats(db);
  const workspace = getWorkspace(db, workspaceId);
  const enrichment = getEnrichmentStats(db);
  return json({ ...stats, workspace, db_size_mb: +(stats.dbSizeBytes / 1024 / 1024).toFixed(2), enrichment });
}

function handleEnrichTrigger(onEnrich?: EnrichCallback): Response {
  if (!onEnrich) return json({ error: "enrichment not enabled" }, 400);
  onEnrich();
  return json({ status: "queued" });
}

async function handleSync(req: Request, onSync: SyncCallback): Promise<Response> {
  let channel: string | undefined;
  try {
    const body = await req.json() as { channel?: string };
    channel = body.channel;
  } catch { /* empty body is fine */ }

  onSync({ channels: channel ? [channel] : undefined });
  return json({ status: "queued", channel: channel ?? null });
}

function handleSQL(db: Database, url: URL): Response {
  const q = url.searchParams.get("q");
  if (!q) return json({ error: "q is required" }, 400);
  try {
    const rows = execReadOnly(db, q);
    return json({ rows, total: rows.length });
  } catch (err) {
    return json({ error: String(err) }, 400);
  }
}

function handleThreads(db: Database, workspaceId: string, url: URL): Response {
  const channelParam = url.searchParams.get("channel");
  const threadTs = url.searchParams.get("thread_ts");
  if (!threadTs) return json({ error: "thread_ts is required" }, 400);
  if (!channelParam) return json({ error: "channel is required" }, 400);

  const ch = getChannelByNameOrId(db, workspaceId, channelParam);
  if (!ch) return json({ error: "channel not found" }, 404);

  const all = getThread(db, ch.id, threadTs);
  if (!all.length) return json({ error: "thread not found" }, 404);

  return json({
    thread_ts: threadTs,
    channel_id: ch.id,
    root: all.find(m => m.ts === threadTs) ?? null,
    replies: all.filter(m => m.ts !== threadTs),
    total: all.length,
  });
}

// ---- Helpers ----

function checkAuth(req: Request, apiKey: string): boolean {
  if (!apiKey) return true; // no key configured = open
  const auth = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${apiKey}`;
  if (auth.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function int(s: string | null, def: number): number {
  if (!s) return def;
  const n = parseInt(s);
  return isNaN(n) ? def : n;
}

function parseSince(p: URLSearchParams): number | undefined {
  const s = p.get("since");
  if (!s) return undefined;
  const t = new Date(s).getTime();
  return isNaN(t) ? undefined : Math.floor(t / 1000);
}
