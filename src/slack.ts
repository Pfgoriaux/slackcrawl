// Slack Web API client — plain fetch, no SDK.
//
// A single global rate limiter spaces ALL requests (history, replies, list, etc.)
// by `minIntervalMs`, so concurrent channel syncs cannot burst past Slack's limits.
// Note: as of 2025-05-29 Slack throttles conversations.history/.replies hard for
// non-Marketplace apps created after that date (≈1 req/min, ≤15 msgs/page). Internal
// custom apps keep the old Tier-3 (~50/min). Tune via SLACKCRAWL_SLACK_MIN_INTERVAL_MS
// and SLACKCRAWL_SLACK_PAGE_LIMIT. The 429 handler honors Retry-After regardless.

const BASE = "https://slack.com/api";

export interface WorkspaceInfo {
  id: string;
  name: string;
  domain: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_archived: boolean;
  is_member: boolean;
  num_members: number;
  created: number;
  topic: { value: string };
  purpose: { value: string };
}

export interface SlackUser {
  id: string;
  name: string; // handle
  real_name: string;
  is_bot: boolean;
  deleted: boolean;
  profile: {
    display_name: string;
    email: string;
    title: string;
    image_192: string;
    image_72: string;
  };
}

export interface SlackMessage {
  type: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  latest_reply?: string;
  user?: string;
  username?: string;
  text: string;
  reply_count?: number;
  reply_users?: string[];
  reactions?: Array<{ name: string; count: number; users: string[] }>;
  files?: unknown[];
  attachments?: unknown[];
  edited?: { ts: string };
}

export interface AuthTestResult {
  user_id: string;
  user: string;
  team_id: string;
  team: string;
}

export interface SlackClientOptions {
  minIntervalMs?: number;
  historyLimit?: number;
}

export class SlackClient {
  private readonly minIntervalMs: number;
  private readonly historyLimit: number;
  private nextSlot = 0; // global rate-limiter cursor (epoch ms)

  constructor(private readonly token: string, opts: SlackClientOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 1200;
    this.historyLimit = opts.historyLimit ?? 200;
  }

  async authTest(): Promise<AuthTestResult> {
    return this.get("auth.test", {});
  }

  async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    const data = await this.get<{ team: WorkspaceInfo }>("team.info", {});
    return data.team;
  }

  async *listChannels(types = "public_channel,private_channel"): AsyncGenerator<SlackChannel> {
    let cursor = "";
    do {
      const data = await this.get<{
        channels: SlackChannel[];
        response_metadata: { next_cursor: string };
      }>("conversations.list", { types, exclude_archived: "false", limit: "200", cursor });
      for (const ch of data.channels) yield ch;
      cursor = data.response_metadata?.next_cursor ?? "";
    } while (cursor);
  }

  async *listUsers(): AsyncGenerator<SlackUser> {
    let cursor = "";
    do {
      const data = await this.get<{
        members: SlackUser[];
        response_metadata: { next_cursor: string };
      }>("users.list", { limit: "200", cursor });
      for (const u of data.members) yield u;
      cursor = data.response_metadata?.next_cursor ?? "";
    } while (cursor);
  }

  /** Page through a channel's top-level history. `oldest` is exclusive (incremental). */
  async *iterHistory(
    channelId: string,
    opts: { oldest?: string } = {},
  ): AsyncGenerator<SlackMessage> {
    let cursor = "";
    do {
      const data = await this.get<{
        messages: SlackMessage[];
        has_more: boolean;
        response_metadata: { next_cursor: string };
      }>("conversations.history", {
        channel: channelId,
        limit: String(this.historyLimit),
        ...(opts.oldest ? { oldest: opts.oldest } : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const m of data.messages) yield m;
      cursor = data.has_more ? (data.response_metadata?.next_cursor ?? "") : "";
    } while (cursor);
  }

  /** Fetch thread replies. `oldest` (exclusive) lets us pull only new replies. */
  async getReplies(channelId: string, threadTs: string, opts: { oldest?: string } = {}): Promise<SlackMessage[]> {
    const all: SlackMessage[] = [];
    let cursor = "";
    do {
      const data = await this.get<{
        messages: SlackMessage[];
        has_more: boolean;
        response_metadata: { next_cursor: string };
      }>("conversations.replies", {
        channel: channelId,
        ts: threadTs,
        limit: String(this.historyLimit),
        ...(opts.oldest ? { oldest: opts.oldest } : {}),
        ...(cursor ? { cursor } : {}),
      });
      all.push(...data.messages);
      cursor = data.has_more ? (data.response_metadata?.next_cursor ?? "") : "";
    } while (cursor);
    return all;
  }

  // ---- HTTP ----

  private async get<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE}/${method}`);
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }

    return this.withRetry(async () => {
      await this.acquireSlot();
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.token}` },
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
        throw new RateLimitError((isNaN(retryAfter) ? 60 : retryAfter) * 1000);
      }
      if (!res.ok) throw new Error(`Slack HTTP ${res.status} for ${method}`);

      const json = await res.json() as { ok: boolean; error?: string } & T;
      if (!json.ok) throw new Error(`Slack API error: ${json.error}`);
      return json;
    });
  }

  /** Reserve the next time slot so all requests are spaced by minIntervalMs globally. */
  private async acquireSlot(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.minIntervalMs;
    const wait = start - now;
    if (wait > 0) await sleep(wait);
  }

  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof RateLimitError) {
          const wait = err.retryAfterMs + Math.random() * 5000;
          // Push the global slot cursor out so other in-flight requests also back off.
          this.nextSlot = Math.max(this.nextSlot, Date.now() + wait);
          console.log(`[slack] rate limited, waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${maxAttempts})`);
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Slack: exceeded max retries (${maxAttempts})`);
  }
}

class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limited, retry after ${retryAfterMs}ms`);
  }
}

// ---- Helpers ----

export function tsToUnix(ts: string): number {
  return Math.floor(parseFloat(ts));
}

export function messageId(workspaceId: string, channelId: string, ts: string): string {
  return `${workspaceId}:${channelId}:${ts}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
