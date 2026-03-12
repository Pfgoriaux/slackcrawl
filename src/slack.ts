// Slack Web API client — plain fetch, no SDK.

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
  ts: string;
  thread_ts?: string;
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

export class SlackClient {
  constructor(private readonly token: string) {}

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
      if (cursor) await sleep(200);
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
      if (cursor) await sleep(200);
    } while (cursor);
  }

  async getHistory(
    channelId: string,
    opts: { oldest?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ messages: SlackMessage[]; has_more: boolean; next_cursor: string }> {
    const data = await this.get<{
      messages: SlackMessage[];
      has_more: boolean;
      response_metadata: { next_cursor: string };
    }>("conversations.history", {
      channel: channelId,
      limit: String(opts.limit ?? 200),
      ...(opts.oldest ? { oldest: opts.oldest } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });
    return {
      messages: data.messages,
      has_more: data.has_more,
      next_cursor: data.response_metadata?.next_cursor ?? "",
    };
  }

  async getReplies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
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
        limit: "200",
        cursor,
      });
      all.push(...data.messages);
      cursor = data.has_more ? (data.response_metadata?.next_cursor ?? "") : "";
      if (cursor) await sleep(200);
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
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.token}` },
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60");
        throw new RateLimitError(retryAfter * 1000);
      }
      if (!res.ok) throw new Error(`Slack HTTP ${res.status} for ${method}`);

      const json = await res.json() as { ok: boolean; error?: string } & T;
      if (!json.ok) throw new Error(`Slack API error: ${json.error}`);
      return json;
    });
  }

  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof RateLimitError) {
          const wait = err.retryAfterMs + Math.random() * 5000;
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
