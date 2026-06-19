import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import {
  queryMessages, getChannels, getUsers,
  getWorkspace, getStats, getThread, expandThreads,
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
import type { ApiKey } from "./config";
import { json, int, parseSince, parseDateParam } from "./util";

type SyncCallback = (opts: SyncOptions) => void;
type EnrichCallback = () => void;

export interface WorkspaceRef { workspaceId: string }

export interface ServerOptions {
  vecIndex?: VecIndex | null;
  embedder?: EmbeddingClient | null;
  onEnrich?: EnrichCallback;
  port: number;
  host: string;
  maxLimit: number;
  maxBodyBytes?: number;
  isReady?: () => boolean;
}

export function createServer(
  db: Database,
  apiKeys: ApiKey[],
  wsRef: WorkspaceRef,
  onSync: SyncCallback,
  opts: ServerOptions,
) {
  const maxLimit = opts.maxLimit;

  return Bun.serve({
    port: opts.port,
    hostname: opts.host,
    maxRequestBodySize: opts.maxBodyBytes ?? 1024 * 1024, // 1 MiB
    idleTimeout: 30,

    async fetch(req) {
      const started = Date.now();
      const url = new URL(req.url);
      const path = url.pathname;
      let status = 200;
      let keyName = "-";

      try {
        // CORS preflight — no auth, no body.
        if (req.method === "OPTIONS") return json(null, 204);

        // Liveness — always 200 while the server responds (don't gate on readiness, or a
        // long initial sync would trip container restarts). Readiness is in the body.
        if (path === "/health") {
          const ready = opts.isReady ? opts.isReady() : true;
          return json({ status: "ok", ready, time: new Date().toISOString() });
        }

        // OpenAPI schema — no auth required (agent discovery).
        if (path === "/v1/schema") return json(openApiSchema());

        // Auth for all /v1/* routes.
        const auth = authenticate(req, apiKeys);
        if (!auth) { status = 401; return json({ error: "unauthorized" }, 401); }
        keyName = auth.name;

        const workspaceId = wsRef.workspaceId;
        const enrichDeps: EnrichApiDeps = {
          db,
          workspaceId,
          vecIndex: opts.vecIndex ?? null,
          embedder: opts.embedder ?? null,
          maxLimit,
        };

        const res = await route(req, url, path, db, workspaceId, maxLimit, enrichDeps, onSync, opts.onEnrich);
        status = res.status;
        return res;
      } catch (err) {
        console.error("[api] handler error:", err);
        status = 500;
        return json({ error: "internal server error" }, 500);
      } finally {
        const ms = Date.now() - started;
        console.log(`[api] ${req.method} ${path} ${status} ${ms}ms key=${keyName}`);
      }
    },

    error(err) {
      console.error("[api] unhandled error:", err);
      return json({ error: "internal server error" }, 500);
    },
  });
}

function route(
  req: Request, url: URL, path: string,
  db: Database, workspaceId: string, maxLimit: number,
  enrichDeps: EnrichApiDeps, onSync: SyncCallback, onEnrich?: EnrichCallback,
): Response | Promise<Response> {
  if (path === "/v1/search" && req.method === "GET") return handleEnhancedSearch(enrichDeps, url);
  if (path === "/v1/messages" && req.method === "GET") return handleMessages(db, workspaceId, maxLimit, url);
  if (path === "/v1/threads" && req.method === "GET") return handleThreads(db, workspaceId, url);
  if (path === "/v1/channels" && req.method === "GET") return handleChannels(db, workspaceId, url);
  if (path === "/v1/members" && req.method === "GET") return handleMembers(db, workspaceId, url);
  if (path === "/v1/status" && req.method === "GET") return handleStatus(db, workspaceId);
  if (path === "/v1/sync" && req.method === "POST") return handleSync(req, onSync);

  // Enrichment endpoints
  if (path === "/v1/decisions" && req.method === "GET") return handleDecisions(enrichDeps, url);
  if (path === "/v1/digests" && req.method === "GET") return handleDigests(enrichDeps, url);
  if (path === "/v1/expertise" && req.method === "GET") return handleExpertise(enrichDeps, url);
  if (path === "/v1/context" && req.method === "GET") return handleContext(enrichDeps, url);
  if (path === "/v1/enrich" && req.method === "POST") return handleEnrichTrigger(onEnrich);

  return json({ error: "not found" }, 404);
}

// ---- Handlers ----

function handleMessages(db: Database, workspaceId: string, maxLimit: number, url: URL): Response {
  const p = url.searchParams;
  const hours = int(p.get("hours"), 0);
  const days  = int(p.get("days"), 0);

  let since = parseSince(p);
  if (!since && hours) since = Math.floor(Date.now() / 1000) - hours * 3600;
  if (!since && days)  since = Math.floor(Date.now() / 1000) - days * 86400;

  const until = parseDateParam(p.get("until"));

  const messages = queryMessages(db, {
    workspaceId,
    channelName: p.get("channel") ?? undefined,
    username: p.get("author") ?? undefined,
    since,
    until,
    last: int(p.get("last"), 0, maxLimit) || undefined,
    limit: int(p.get("limit"), 100, maxLimit),
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
  let full = false;
  try {
    const body = await req.json() as { channel?: string; full?: boolean };
    channel = body.channel;
    full = body.full === true;
  } catch { /* empty body is fine */ }

  onSync({ channels: channel ? [channel] : undefined, full });
  return json({ status: "queued", channel: channel ?? null, full });
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

// ---- Auth ----

/** Constant-time multi-key check. Returns the matched key (name) or null. */
function authenticate(req: Request, apiKeys: ApiKey[]): { name: string } | null {
  if (apiKeys.length === 0) return { name: "anon" }; // explicit no-auth mode (SLACKCRAWL_ALLOW_NO_AUTH)
  const auth = req.headers.get("Authorization") ?? "";
  const authBuf = Buffer.from(auth);
  let matched: { name: string } | null = null;
  // Check every key (no early exit) so timing doesn't reveal which key matched.
  for (const k of apiKeys) {
    const expected = Buffer.from(`Bearer ${k.key}`);
    if (authBuf.length === expected.length && timingSafeEqual(authBuf, expected)) {
      matched = { name: k.name };
    }
  }
  return matched;
}

function openApiSchema() {
  return {
    openapi: "3.0.3",
    info: {
      title: "slackcrawl",
      version: "0.2.0",
      description: "Slack archive REST API for AI agents. Mirrors public + private channels into SQLite with optional AI enrichment.",
    },
    paths: {
      "/health": {
        get: { summary: "Liveness check (body includes `ready` once the first sync completes)", security: [], responses: { "200": { description: "OK" } } },
      },
      "/v1/search": {
        get: {
          summary: "Search messages (keyword, semantic, or hybrid)",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "mode", in: "query", schema: { type: "string", enum: ["keyword", "semantic", "hybrid"], default: "keyword" } },
            { name: "channel", in: "query", schema: { type: "string" } },
            { name: "author", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "string", format: "date" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "include_threads", in: "query", schema: { type: "boolean" } },
          ],
        },
      },
      "/v1/messages": {
        get: {
          summary: "Query messages with filters",
          parameters: [
            { name: "channel", in: "query", schema: { type: "string" } },
            { name: "days", in: "query", schema: { type: "integer", default: 7 } },
            { name: "hours", in: "query", schema: { type: "integer" } },
            { name: "author", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "string", format: "date" } },
            { name: "until", in: "query", schema: { type: "string", format: "date" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
            { name: "include_threads", in: "query", schema: { type: "boolean" } },
          ],
        },
      },
      "/v1/threads": {
        get: {
          summary: "Get thread by timestamp",
          parameters: [
            { name: "channel", in: "query", required: true, schema: { type: "string" } },
            { name: "thread_ts", in: "query", required: true, schema: { type: "string" } },
          ],
        },
      },
      "/v1/channels": {
        get: {
          summary: "List channels",
          parameters: [
            { name: "archived", in: "query", schema: { type: "boolean" } },
          ],
        },
      },
      "/v1/members": {
        get: {
          summary: "Search members",
          parameters: [
            { name: "query", in: "query", schema: { type: "string" } },
          ],
        },
      },
      "/v1/status": { get: { summary: "DB and enrichment statistics" } },
      "/v1/sync": { post: { summary: "Trigger background sync", requestBody: { content: { "application/json": { schema: { type: "object", properties: { channel: { type: "string" }, full: { type: "boolean" } } } } } } } },
      "/v1/context": {
        get: {
          summary: "Bundled context for agents — the main endpoint",
          parameters: [
            { name: "topic", in: "query", required: true, schema: { type: "string" } },
            { name: "channel", in: "query", schema: { type: "string" } },
            { name: "days", in: "query", schema: { type: "integer", default: 14 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 10 } },
          ],
        },
      },
      "/v1/decisions": {
        get: {
          summary: "Query extracted decisions and action items",
          parameters: [
            { name: "channel", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "string", format: "date" } },
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "category", in: "query", schema: { type: "string", enum: ["decision", "action_item", "conclusion", "commitment"] } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          ],
        },
      },
      "/v1/digests": {
        get: {
          summary: "Query daily channel digests",
          parameters: [
            { name: "channel", in: "query", schema: { type: "string" } },
            { name: "days", in: "query", schema: { type: "integer", default: 7 } },
            { name: "date", in: "query", schema: { type: "string", format: "date" } },
          ],
        },
      },
      "/v1/expertise": {
        get: {
          summary: "Search expertise profiles or get user profile",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "user", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          ],
        },
      },
      "/v1/enrich": { post: { summary: "Trigger enrichment pipeline" } },
    },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
      },
    },
    security: [{ bearer: [] }],
  };
}
