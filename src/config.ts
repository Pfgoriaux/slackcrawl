export interface Config {
  slackToken: string;
  apiKey: string;
  channels: string[]; // empty = all channels bot is in
  syncIntervalMs: number;
  dbPath: string;
  port: number;
  host: string;
  // AI enrichment
  claudeApiKey: string;
  openaiApiKey: string;
  claudeModel: string;
  embeddingModel: string;
  enrichEnabled: boolean;
  enrichBatch: number;
  enrichMinReplies: number;
}

export function loadConfig(): Config {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) throw new Error("SLACK_BOT_TOKEN is required");

  const dataDir = process.env.DATA_DIR ?? `${process.env.HOME}/.slackcrawl`;

  const channels = (process.env.SLACKCRAWL_CHANNELS ?? "")
    .split(",")
    .map((c) => c.trim().replace(/^#/, ""))
    .filter(Boolean);

  const claudeApiKey = process.env.CLAUDE_API_KEY ?? "";
  const openaiApiKey = process.env.OPENAI_API_KEY ?? "";

  return {
    slackToken,
    apiKey: process.env.SLACKCRAWL_API_KEY ?? "",
    channels,
    syncIntervalMs: parseDuration(process.env.SLACKCRAWL_SYNC_INTERVAL ?? "10m"),
    dbPath: process.env.SLACKCRAWL_DB_PATH ?? `${dataDir}/slackcrawl.db`,
    port: parseInt(process.env.PORT ?? "8080"),
    host: process.env.SLACKCRAWL_HOST ?? "0.0.0.0",
    claudeApiKey,
    openaiApiKey,
    claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514",
    embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    enrichEnabled: !!(claudeApiKey && openaiApiKey),
    enrichBatch: parseInt(process.env.SLACKCRAWL_ENRICH_BATCH ?? "100"),
    enrichMinReplies: parseInt(process.env.SLACKCRAWL_ENRICH_MIN_REPLIES ?? "2"),
  };
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m|h)$/);
  if (!m) return 10 * 60 * 1000;
  const n = parseInt(m[1]);
  switch (m[2]) {
    case "ms": return n;
    case "s":  return n * 1_000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
    default:   return 10 * 60_000;
  }
}
