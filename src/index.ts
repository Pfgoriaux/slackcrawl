import { loadConfig, type Config } from "./config";
import { openDB, getWorkspace, getStats } from "./db";
import { getEnrichmentStats } from "./enrich-db";
import { SlackClient } from "./slack";
import { runSync } from "./sync";
import { createServer, type WorkspaceRef } from "./api";
import { ClaudeClient, EmbeddingClient } from "./ai";
import { VecIndex } from "./vec";
import { runEnrichment } from "./enrich";

const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve":  await cmdServe();  break;
  case "sync":   await cmdSync();   break;
  case "enrich": await cmdEnrich(); break;
  case "doctor": await cmdDoctor(); break;
  case "status": await cmdStatus(); break;
  case "help":
  case "--help":
  case "-h":
    console.log("Usage: slackcrawl <command>\n");
    console.log("Commands:");
    console.log("  serve   Start REST API + background sync loop");
    console.log("  sync    One-time sync (--full, --channel NAME)");
    console.log("  enrich  Run AI enrichment manually");
    console.log("  doctor  Check token, config, DB, and AI keys");
    console.log("  status  Show DB and enrichment statistics");
    console.log("\nhttps://github.com/Pfgoriaux/slackcrawl");
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: slackcrawl [serve|sync|enrich|doctor|status]");
    process.exit(1);
}

// ---- Commands ----

function slackClient(cfg: Config): SlackClient {
  return new SlackClient(cfg.slackToken, {
    minIntervalMs: cfg.slackMinIntervalMs,
    historyLimit: cfg.slackHistoryLimit,
  });
}

async function cmdServe() {
  const cfg = loadConfig();

  // Fail closed: refuse to serve sensitive data unauthenticated unless explicitly allowed.
  if (cfg.apiKeys.length === 0 && !cfg.allowNoAuth) {
    console.error("[serve] FATAL: no API key set. Set SLACKCRAWL_API_KEY (or SLACKCRAWL_API_KEYS),");
    console.error("        or set SLACKCRAWL_ALLOW_NO_AUTH=true to intentionally run unauthenticated.");
    process.exit(1);
  }

  const db  = openDB(cfg.dbPath);
  const client = slackClient(cfg);

  const claude = cfg.claudeApiKey ? new ClaudeClient(cfg.claudeApiKey, cfg.claudeModel) : null;
  const embedder = cfg.openaiApiKey ? new EmbeddingClient(cfg.openaiApiKey, cfg.embeddingModel) : null;
  const vecIndex = new VecIndex();
  if (cfg.enrichEnabled) vecIndex.load(db);

  let syncRunning = false;
  let enrichRunning = false;
  let firstSyncDone = false;
  let shuttingDown = false;

  const wsRef: WorkspaceRef = { workspaceId: "" };

  async function doSync(opts: { channels?: string[]; full?: boolean } = {}) {
    if (shuttingDown) return;
    if (syncRunning) { console.log("[sync] already running, skipping"); return; }
    syncRunning = true;
    try {
      await runSync(db, client, {
        full: opts.full,
        channels: opts.channels ?? cfg.channels,
        threadRepollDays: cfg.threadRepollDays,
      });
      // Re-resolve workspace id from the now-populated DB if startup couldn't fetch it.
      if (!wsRef.workspaceId) {
        const ws = getWorkspace(db);
        if (ws) wsRef.workspaceId = ws.id;
      }
      firstSyncDone = true;
      // Enrichment runs after sync but is NOT awaited here, so the sync loop is never
      // blocked by long enrichment runs. enrichRunning prevents overlap.
      if (cfg.enrichEnabled) doEnrich().catch((e) => console.error("[enrich] error:", e));
    } catch (err) {
      console.error("[sync] error:", err);
    } finally {
      syncRunning = false;
    }
  }

  async function doEnrich() {
    if (shuttingDown) return;
    if (enrichRunning) { console.log("[enrich] already running, skipping"); return; }
    if (!claude || !embedder) { console.log("[enrich] AI keys not configured"); return; }
    enrichRunning = true;
    try {
      await runEnrichment(db, cfg, claude, embedder);
      vecIndex.load(db); // refresh vector index
    } catch (err) {
      console.error("[enrich] error:", err);
    } finally {
      enrichRunning = false;
    }
  }

  // Resolve workspace id up front (best effort).
  try {
    wsRef.workspaceId = (await client.getWorkspaceInfo()).id;
  } catch (err) {
    console.warn("[serve] could not fetch workspace info, will resolve after first sync:", err);
    wsRef.workspaceId = getWorkspace(db)?.id ?? "";
  }

  const server = createServer(db, cfg.apiKeys, wsRef, (opts) => { doSync(opts).catch(console.error); }, {
    vecIndex,
    embedder,
    onEnrich: cfg.enrichEnabled ? () => { doEnrich().catch(console.error); } : undefined,
    port: cfg.port,
    host: cfg.host,
    maxLimit: cfg.maxLimit,
    isReady: () => firstSyncDone && !!wsRef.workspaceId,
  });

  console.log(`[serve] listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[serve] auth: ${cfg.apiKeys.length ? `${cfg.apiKeys.length} key(s) [${cfg.apiKeys.map((k) => k.name).join(", ")}]` : "DISABLED (SLACKCRAWL_ALLOW_NO_AUTH)"}`);
  if (cfg.enrichEnabled) {
    console.log(`[serve] enrichment enabled (claude: ${cfg.claudeModel}, embeddings: ${cfg.embeddingModel})`);
  } else {
    console.log("[serve] enrichment disabled (set CLAUDE_API_KEY + OPENAI_API_KEY to enable)");
  }

  // Initial sync (full if requested on the CLI).
  doSync({ full: process.argv.includes("--full") }).catch(console.error);

  // Incremental polling loop.
  console.log(`[serve] sync interval: ${cfg.syncIntervalMs / 1000}s; reconcile interval: ${cfg.reconcileIntervalMs ? cfg.reconcileIntervalMs / 1000 + "s" : "disabled"}`);
  const syncTimer = setInterval(() => doSync(), cfg.syncIntervalMs);

  // Periodic full reconciliation: catches edits, deletions (tombstones), and any
  // replies missed by incremental sync.
  const reconcileTimer = cfg.reconcileIntervalMs > 0
    ? setInterval(() => doSync({ full: true }), cfg.reconcileIntervalMs)
    : null;

  // ---- Graceful shutdown ----
  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    console.log(`[serve] ${signal} received, shutting down...`);
    clearInterval(syncTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);

    // Stop accepting new connections (let in-flight requests finish).
    await server.stop();

    // Wait (bounded) for an in-flight sync/enrichment to reach a safe point.
    const deadline = Date.now() + 25_000;
    while ((syncRunning || enrichRunning) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (syncRunning || enrichRunning) console.warn("[serve] shutdown timeout — closing DB with work still in progress");

    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    db.close();
    console.log("[serve] bye");
    process.exit(0);
  };
  process.on("SIGINT", () => { shutdown("SIGINT"); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
}

async function cmdSync() {
  const cfg = loadConfig();
  const db  = openDB(cfg.dbPath);
  const client = slackClient(cfg);

  const full = process.argv.includes("--full");
  const channelArg = argValue("--channel");
  const channels = channelArg ? [channelArg] : cfg.channels;

  await runSync(db, client, { full, channels, threadRepollDays: cfg.threadRepollDays });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

async function cmdEnrich() {
  const cfg = loadConfig();
  const db  = openDB(cfg.dbPath);

  if (!cfg.claudeApiKey || !cfg.openaiApiKey) {
    console.error("[enrich] CLAUDE_API_KEY and OPENAI_API_KEY are required");
    process.exit(1);
  }

  const claude = new ClaudeClient(cfg.claudeApiKey, cfg.claudeModel);
  const embedder = new EmbeddingClient(cfg.openaiApiKey, cfg.embeddingModel);

  const result = await runEnrichment(db, cfg, claude, embedder);
  console.log("[enrich] result:", result);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

async function cmdDoctor() {
  let ok = true;

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.log("[FAIL] SLACK_BOT_TOKEN is not set");
    ok = false;
  } else {
    try {
      const auth = await new SlackClient(token).authTest();
      console.log(`[OK]   Slack auth: ${auth.user} @ ${auth.team}`);
    } catch (err) {
      console.log(`[FAIL] Slack auth: ${err}`);
      ok = false;
    }
  }

  try {
    const cfg = loadConfig();
    if (cfg.apiKeys.length) {
      console.log(`[OK]   API keys: ${cfg.apiKeys.length} (${cfg.apiKeys.map((k) => k.name).join(", ")})`);
    } else if (cfg.allowNoAuth) {
      console.log("[WARN] API unauthenticated (SLACKCRAWL_ALLOW_NO_AUTH=true)");
    } else {
      console.log("[FAIL] No API key set and SLACKCRAWL_ALLOW_NO_AUTH not set — serve will refuse to start");
      ok = false;
    }

    console.log(cfg.channels.length ? `[OK]   Channels: ${cfg.channels.join(", ")}` : "[INFO] Channels: all channels the bot is invited to");
    console.log(cfg.enrichEnabled ? "[OK]   AI enrichment: enabled" : "[INFO] AI enrichment: disabled (need CLAUDE_API_KEY + OPENAI_API_KEY)");

    const db  = openDB(cfg.dbPath);
    const stats = getStats(db);
    console.log(`[OK]   DB: ${stats.channels} channels, ${stats.users} users, ${stats.messages} messages (${(stats.dbSizeBytes / 1024 / 1024).toFixed(1)} MB)`);
    const enrichStats = getEnrichmentStats(db);
    if (enrichStats.enrichment_log > 0) {
      console.log(`[OK]   Enrichment: ${enrichStats.thread_summaries} summaries, ${enrichStats.decisions} decisions, ${enrichStats.channel_digests} digests, ${enrichStats.message_embeddings} embeddings, ${enrichStats.user_profiles} profiles`);
    }
    db.close();
  } catch (err) {
    console.log(`[FAIL] ${err}`);
    ok = false;
  }

  process.exit(ok ? 0 : 1);
}

async function cmdStatus() {
  const cfg = loadConfig();
  const db  = openDB(cfg.dbPath);

  const ws    = getWorkspace(db);
  const stats = getStats(db);

  if (ws) console.log(`Workspace: ${ws.name} (${ws.id})`);
  console.log(`Channels:  ${stats.channels}`);
  console.log(`Users:     ${stats.users}`);
  console.log(`Messages:  ${stats.messages}`);
  console.log(`DB size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`DB path:   ${cfg.dbPath}`);

  const enrichStats = getEnrichmentStats(db);
  console.log(`\nEnrichment:`);
  console.log(`  Summaries:  ${enrichStats.thread_summaries}`);
  console.log(`  Decisions:  ${enrichStats.decisions}`);
  console.log(`  Digests:    ${enrichStats.channel_digests}`);
  console.log(`  Embeddings: ${enrichStats.message_embeddings}`);
  console.log(`  Profiles:   ${enrichStats.user_profiles}`);
  console.log(`  Enabled:    ${cfg.enrichEnabled}`);

  db.close();
}

// ---- Helpers ----

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}
