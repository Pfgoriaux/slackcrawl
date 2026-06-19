export interface ApiKey {
  name: string;
  key: string;
}

export interface Config {
  slackToken: string;
  apiKeys: ApiKey[];      // empty = no auth (only allowed with allowNoAuth)
  allowNoAuth: boolean;
  channels: string[];     // empty = all channels bot is in
  syncIntervalMs: number;
  reconcileIntervalMs: number; // 0 = disabled
  dbPath: string;
  port: number;
  host: string;
  maxLimit: number;       // hard cap on any `limit`/`last` query param
  threadRepollDays: number; // re-poll replies for threads active within N days each cycle
  // Slack pacing
  slackMinIntervalMs: number; // min ms between Slack API calls (global)
  slackHistoryLimit: number;  // page size for conversations.history / .replies
  // AI enrichment
  claudeApiKey: string;
  openaiApiKey: string;
  claudeModel: string;
  embeddingModel: string;
  enrichEnabled: boolean;
  enrichBatch: number;
  enrichMinReplies: number;
  enrichMaxPerCycle: number;  // cap items processed per stage per enrichment run
}

const PLACEHOLDER_KEYS = new Set([
  "your-secret-api-key",
  "your-secret",
  "my-secret",
  "changeme",
]);

export function loadConfig(): Config {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) throw new Error("SLACK_BOT_TOKEN is required");

  const dataDir = process.env.DATA_DIR ?? `${process.env.HOME}/.slackcrawl`;

  const channels = (process.env.SLACKCRAWL_CHANNELS ?? "")
    .split(",")
    .map((c) => c.trim().replace(/^#/, ""))
    .filter(Boolean);

  const apiKeys = parseApiKeys();
  const allowNoAuth = process.env.SLACKCRAWL_ALLOW_NO_AUTH === "true";

  const claudeApiKey = process.env.CLAUDE_API_KEY ?? "";
  const openaiApiKey = process.env.OPENAI_API_KEY ?? "";

  return {
    slackToken,
    apiKeys,
    allowNoAuth,
    channels,
    syncIntervalMs: parseDuration(process.env.SLACKCRAWL_SYNC_INTERVAL, 10 * 60_000),
    reconcileIntervalMs: parseDuration(process.env.SLACKCRAWL_RECONCILE_INTERVAL, 24 * 3_600_000),
    dbPath: process.env.SLACKCRAWL_DB_PATH ?? `${dataDir}/slackcrawl.db`,
    port: posInt(process.env.PORT, 8080, "PORT"),
    host: process.env.SLACKCRAWL_HOST ?? "0.0.0.0",
    maxLimit: posInt(process.env.SLACKCRAWL_MAX_LIMIT, 500, "SLACKCRAWL_MAX_LIMIT"),
    threadRepollDays: posInt(process.env.SLACKCRAWL_THREAD_REPOLL_DAYS, 14, "SLACKCRAWL_THREAD_REPOLL_DAYS"),
    slackMinIntervalMs: posInt(process.env.SLACKCRAWL_SLACK_MIN_INTERVAL_MS, 1200, "SLACKCRAWL_SLACK_MIN_INTERVAL_MS"),
    slackHistoryLimit: clamp(posInt(process.env.SLACKCRAWL_SLACK_PAGE_LIMIT, 200, "SLACKCRAWL_SLACK_PAGE_LIMIT"), 1, 1000),
    claudeApiKey,
    openaiApiKey,
    claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
    embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    enrichEnabled: !!(claudeApiKey && openaiApiKey),
    enrichBatch: clamp(posInt(process.env.SLACKCRAWL_ENRICH_BATCH, 100, "SLACKCRAWL_ENRICH_BATCH"), 1, 2048),
    enrichMinReplies: posInt(process.env.SLACKCRAWL_ENRICH_MIN_REPLIES, 2, "SLACKCRAWL_ENRICH_MIN_REPLIES"),
    enrichMaxPerCycle: posInt(process.env.SLACKCRAWL_ENRICH_MAX_PER_CYCLE, 500, "SLACKCRAWL_ENRICH_MAX_PER_CYCLE"),
  };
}

/**
 * Parse API keys. Two formats, both supported:
 *   SLACKCRAWL_API_KEYS="alice:key1,ci-bot:key2"   (named keys, comma-separated)
 *   SLACKCRAWL_API_KEY="key"                        (single key, name defaults to "default")
 * Named keys take precedence; if both are set they are merged.
 */
function parseApiKeys(): ApiKey[] {
  const keys: ApiKey[] = [];
  const seen = new Set<string>();

  const add = (name: string, key: string) => {
    const k = key.trim();
    if (!k) return;
    if (PLACEHOLDER_KEYS.has(k)) {
      throw new Error(
        `Refusing to start: API key for "${name}" is the example placeholder "${k}". Set a real secret.`,
      );
    }
    if (k.length < 16) {
      throw new Error(`Refusing to start: API key for "${name}" is too short (min 16 chars).`);
    }
    if (seen.has(k)) return;
    seen.add(k);
    keys.push({ name: name.trim() || "default", key: k });
  };

  const multi = process.env.SLACKCRAWL_API_KEYS;
  if (multi) {
    for (const pair of multi.split(",")) {
      const idx = pair.indexOf(":");
      if (idx === -1) { add("default", pair); continue; }
      add(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }

  const single = process.env.SLACKCRAWL_API_KEY;
  if (single) add("default", single);

  return keys;
}

function posInt(s: string | undefined, def: number, name: string): number {
  if (s === undefined || s === "") return def;
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0) {
    throw new Error(`Invalid ${name}: "${s}" (expected a non-negative integer)`);
  }
  return n;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Parse a Go-style duration ("5m", "1h", "30s", "500ms"). Returns `def` on malformed input. */
function parseDuration(s: string | undefined, def: number): number {
  if (!s) return def;
  const m = s.trim().match(/^(\d+)(ms|s|m|h)$/);
  if (!m) {
    console.warn(`[config] malformed duration "${s}", using default ${def}ms`);
    return def;
  }
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "ms": return n;
    case "s":  return n * 1_000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
    default:   return def;
  }
}
