import { loadConfig } from "./config";
import { openDB, getWorkspace, getStats, getChannels, getUsers } from "./db";
import { getEnrichmentStats } from "./enrich-db";
import { SlackClient } from "./slack";
import { runSync } from "./sync";
import { createServer } from "./api";
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

async function cmdServe() {
  const cfg = loadConfig();
  const db  = openDB(cfg.dbPath);
  const client = new SlackClient(cfg.slackToken);

  // AI clients (null if not configured)
  const claude = cfg.claudeApiKey ? new ClaudeClient(cfg.claudeApiKey, cfg.claudeModel) : null;
  const embedder = cfg.openaiApiKey ? new EmbeddingClient(cfg.openaiApiKey, cfg.embeddingModel) : null;
  const vecIndex = new VecIndex();

  // Load existing embeddings
  if (cfg.enrichEnabled) {
    vecIndex.load(db);
  }

  let syncRunning = false;
  let enrichRunning = false;

  async function doSync(opts: { channels?: string[]; full?: boolean } = {}) {
    if (syncRunning) { console.log("[sync] already running, skipping"); return; }
    syncRunning = true;
    try {
      await runSync(db, client, {
        full: opts.full,
        channels: opts.channels ?? cfg.channels,
      });

      // Run enrichment after sync if enabled
      if (cfg.enrichEnabled && claude && embedder) {
        await doEnrich();
      }
    } catch (err) {
      console.error("[sync] error:", err);
    } finally {
      syncRunning = false;
    }
  }

  async function doEnrich() {
    if (enrichRunning) { console.log("[enrich] already running, skipping"); return; }
    if (!claude || !embedder) { console.log("[enrich] AI keys not configured"); return; }
    enrichRunning = true;
    try {
      await runEnrichment(db, cfg, claude, embedder);
      vecIndex.load(db); // Refresh vector index
    } catch (err) {
      console.error("[enrich] error:", err);
    } finally {
      enrichRunning = false;
    }
  }

  // Get workspace ID (needed for API queries).
  let workspaceId = "";
  try {
    const ws = await client.getWorkspaceInfo();
    workspaceId = ws.id;
  } catch (err) {
    console.warn("[serve] could not fetch workspace info:", err);
    const ws = getWorkspace(db);
    workspaceId = ws?.id ?? "";
  }

  // Start API server.
  const server = createServer(db, cfg.apiKey, workspaceId, (opts) => {
    doSync(opts).catch(console.error);
  }, {
    vecIndex,
    embedder,
    onEnrich: cfg.enrichEnabled ? () => { doEnrich().catch(console.error); } : undefined,
  });
  console.log(`[serve] listening on http://${cfg.host}:${cfg.port}`);
  if (!cfg.apiKey) console.warn("[serve] warning: SLACKCRAWL_API_KEY not set — API is unauthenticated");
  if (cfg.enrichEnabled) {
    console.log(`[serve] enrichment enabled (claude: ${cfg.claudeModel}, embeddings: ${cfg.embeddingModel})`);
  } else {
    console.log("[serve] enrichment disabled (set CLAUDE_API_KEY + OPENAI_API_KEY to enable)");
  }

  // Initial sync.
  const full = process.argv.includes("--full");
  doSync({ full }).catch(console.error);

  // Polling loop.
  console.log(`[serve] sync interval: ${cfg.syncIntervalMs / 1000}s`);
  setInterval(() => doSync(), cfg.syncIntervalMs);
}

async function cmdSync() {
  const cfg = loadConfig();
  const db  = openDB(cfg.dbPath);
  const client = new SlackClient(cfg.slackToken);

  const full = process.argv.includes("--full");
  const channelArg = argValue("--channel");
  const channels = channelArg ? [channelArg] : cfg.channels;

  await runSync(db, client, { full, channels });
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
      const client = new SlackClient(token);
      const auth = await client.authTest();
      console.log(`[OK]   Slack auth: ${auth.user} @ ${auth.team}`);
    } catch (err) {
      console.log(`[FAIL] Slack auth: ${err}`);
      ok = false;
    }
  }

  if (process.env.SLACKCRAWL_API_KEY) {
    console.log("[OK]   API key configured");
  } else {
    console.log("[WARN] SLACKCRAWL_API_KEY not set — API will be unauthenticated");
  }

  if (process.env.SLACKCRAWL_CHANNELS) {
    console.log(`[OK]   Channels: ${process.env.SLACKCRAWL_CHANNELS}`);
  } else {
    console.log("[INFO] Channels: all channels the bot is invited to");
  }

  // AI enrichment keys
  if (process.env.CLAUDE_API_KEY) {
    console.log("[OK]   CLAUDE_API_KEY configured");
  } else {
    console.log("[INFO] CLAUDE_API_KEY not set — thread summaries/decisions/digests disabled");
  }

  if (process.env.OPENAI_API_KEY) {
    console.log("[OK]   OPENAI_API_KEY configured");
  } else {
    console.log("[INFO] OPENAI_API_KEY not set — semantic search disabled");
  }

  if (process.env.CLAUDE_API_KEY && process.env.OPENAI_API_KEY) {
    console.log("[OK]   AI enrichment: enabled");
  } else {
    console.log("[INFO] AI enrichment: disabled (need both CLAUDE_API_KEY + OPENAI_API_KEY)");
  }

  try {
    const cfg = loadConfig();
    const db  = openDB(cfg.dbPath);
    const stats = getStats(db);
    console.log(`[OK]   DB: ${stats.channels} channels, ${stats.users} users, ${stats.messages} messages (${(stats.dbSizeBytes / 1024 / 1024).toFixed(1)} MB)`);

    const enrichStats = getEnrichmentStats(db);
    if (enrichStats.enrichment_log > 0) {
      console.log(`[OK]   Enrichment: ${enrichStats.thread_summaries} summaries, ${enrichStats.decisions} decisions, ${enrichStats.channel_digests} digests, ${enrichStats.message_embeddings} embeddings, ${enrichStats.user_profiles} profiles`);
    }

    db.close();
  } catch (err) {
    console.log(`[FAIL] DB: ${err}`);
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
