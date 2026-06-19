// Shared helpers used across API route handlers.

export function json(data: unknown, status = 200): Response {
  return new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": process.env.SLACKCRAWL_CORS_ORIGIN ?? "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

/**
 * Parse an int query param. When absent/invalid, returns `def` unchanged (so a sentinel
 * default like 0 stays 0). When a value IS provided and `max` is given, it's clamped to
 * [1, max] to bound resource usage.
 */
export function int(s: string | null, def: number, max?: number): number {
  if (!s) return def;
  const parsed = parseInt(s, 10);
  if (isNaN(parsed)) return def;
  return max !== undefined ? Math.max(1, Math.min(parsed, max)) : parsed;
}

export function parseSince(p: URLSearchParams): number | undefined {
  return parseDateParam(p.get("since"));
}

/** Parse an ISO date param to unix seconds; returns undefined if absent or invalid. */
export function parseDateParam(s: string | null): number | undefined {
  if (!s) return undefined;
  const t = new Date(s).getTime();
  return isNaN(t) ? undefined : Math.floor(t / 1000);
}
