// Shared helpers used across API route handlers.

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": process.env.SLACKCRAWL_CORS_ORIGIN ?? "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

export function int(s: string | null, def: number): number {
  if (!s) return def;
  const n = parseInt(s);
  return isNaN(n) ? def : n;
}

export function parseSince(p: URLSearchParams): number | undefined {
  const s = p.get("since");
  if (!s) return undefined;
  const t = new Date(s).getTime();
  return isNaN(t) ? undefined : Math.floor(t / 1000);
}
