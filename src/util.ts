// Shared helpers used across API route handlers.

/**
 * Build a JSON response. CORS headers are added ONLY when
 * SLACKCRAWL_CORS_ORIGIN is set — there is no wildcard default. This is an
 * agent API; browsers are not an expected client, and a permissive default
 * means any website could read responses cross-origin if a key leaks into
 * a browser context. Set the env var explicitly when you do want CORS.
 */
export function json(data: unknown, status = 200): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const origin = process.env.SLACKCRAWL_CORS_ORIGIN;
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
  }
  return new Response(data === null ? null : JSON.stringify(data), { status, headers });
}

/**
 * Parse an int query param. When absent/invalid, returns `def` unchanged (so a sentinel
 * default like 0 stays 0). When a value IS provided and `max` is given, it's clamped to
 * [1, max] to bound resource usage.
 */
export function int(s: string | null, def: number, max?: number): number {
  if (!s) return def;
  const parsed = parseInt(s, 10);
  if (Number.isNaN(parsed)) return def;
  return max !== undefined ? Math.max(1, Math.min(parsed, max)) : parsed;
}

export function parseSince(p: URLSearchParams): number | undefined {
  return parseDateParam(p.get("since"));
}

/** Parse an ISO date param to unix seconds; returns undefined if absent or invalid. */
export function parseDateParam(s: string | null): number | undefined {
  if (!s) return undefined;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}
