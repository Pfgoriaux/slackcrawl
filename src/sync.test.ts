import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChannelByNameOrId, type Message, openDB, upsertChannel, upsertMessage } from "./db";
import type { SlackClient, SlackMessage } from "./slack";
import { runSync } from "./sync";

const WS = "T-test";

let db: Database;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slackcrawl-sync-test-"));
  db = openDB(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Structural stand-in for SlackClient, driven by plain fixture data. */
function fakeClient(opts: {
  history: Record<string, SlackMessage[]>;
  replies?: Record<string, SlackMessage[]> | ((channel: string, ts: string) => SlackMessage[]);
  repliesError?: Record<string, Error>;
}): SlackClient {
  const getReplies = async (channel: string, ts: string) => {
    const key = `${channel}:${ts}`;
    const err = opts.repliesError?.[key];
    if (err) throw err;
    if (typeof opts.replies === "function") return opts.replies(channel, ts);
    return opts.replies?.[key] ?? [];
  };

  return {
    getWorkspaceInfo: async () => ({ id: WS, name: "test-ws", domain: "test" }),
    authTest: async () => ({ user_id: "U1", user: "bot", team_id: WS, team: "test" }),
    listUsers: async function* () {},
    listChannels: async function* () {
      for (const id of Object.keys(opts.history)) {
        yield {
          id,
          name: id,
          is_private: false,
          is_archived: false,
          is_member: true,
          num_members: 1,
          created: 0,
          topic: { value: "" },
          purpose: { value: "" },
        };
      }
    },
    iterHistory: async function* (channel: string) {
      for (const m of opts.history[channel] ?? []) yield m;
    },
    getReplies,
  } as unknown as SlackClient;
}

function msg(ts: string, extra: Partial<SlackMessage> = {}): SlackMessage {
  return { type: "message", ts, text: `text of ${ts}`, user: "U1", ...extra };
}

function storedMsg(ts: string, channelId: string, extra: Partial<Message> = {}): Message {
  return {
    id: `${WS}:${channelId}:${ts}`,
    workspace_id: WS,
    channel_id: channelId,
    ts,
    thread_ts: null,
    subtype: null,
    user_id: "U1",
    username: "alice",
    text: `text of ${ts}`,
    has_attachments: 0,
    has_files: 0,
    reactions: null,
    reply_count: 0,
    reply_users: null,
    edited_ts: null,
    created_at: Math.floor(parseFloat(ts)),
    deleted_at: null,
    raw_json: null,
    ...extra,
  };
}

function upsertPreexisting(channelId: string, msgs: Message[]) {
  upsertChannel(db, {
    id: channelId,
    workspace_id: WS,
    name: channelId,
    is_private: 0,
    is_archived: 0,
    topic: null,
    purpose: null,
    member_count: 1,
    created_at: 0,
    last_synced_ts: null,
  });
  for (const m of msgs) upsertMessage(db, m);
}

function isTombstoned(ts: string, channelId: string): boolean {
  const row = db
    .query<{ deleted_at: number | null }, [string]>("SELECT deleted_at FROM messages WHERE id = ?")
    .get(`${WS}:${channelId}:${ts}`);
  return !!row?.deleted_at;
}

describe("runSync full reconciliation", () => {
  it("tombstones a thread whose root Slack reports as gone, and finishes the channel", async () => {
    // Pre-stored state: a thread (root 1000 + reply 1001) and a plain message 1002.
    // Slack now says: the thread is gone (thread_not_found), 1002 still exists,
    // plus a new message 2000.
    upsertPreexisting("C1", [
      storedMsg("1000.0000", "C1", { reply_count: 1 }),
      storedMsg("1001.0000", "C1", { thread_ts: "1000.0000" }),
      storedMsg("1002.0000", "C1"),
    ]);

    const client = fakeClient({
      history: { C1: [msg("2000.0000"), msg("1002.0000")] },
      repliesError: { "C1:1000.0000": new Error("Slack API error: thread_not_found") },
    });

    await runSync(db, client, { full: true });

    // The dead thread is tombstoned (root and reply)…
    expect(isTombstoned("1000.0000", "C1")).toBe(true);
    expect(isTombstoned("1001.0000", "C1")).toBe(true);
    // …the surviving message is untouched, the new one was stored…
    expect(isTombstoned("1002.0000", "C1")).toBe(false);
    expect(isTombstoned("2000.0000", "C1")).toBe(false);
    // …and the reconcile completed (watermark advanced) instead of wedging forever.
    expect(getChannelByNameOrId(db, WS, "C1")?.last_synced_ts).toBe("2000.0000");
  });

  it("transient thread failure holds the channel watermark but does not block others", async () => {
    upsertPreexisting("C1", [storedMsg("1000.0000", "C1", { reply_count: 1 })]);

    const client = fakeClient({
      history: {
        C1: [msg("2000.0000"), msg("1000.0000", { reply_count: 1 })],
        C2: [msg("3000.0000")],
      },
      repliesError: { "C1:1000.0000": new Error("Slack HTTP 500") },
    });

    await runSync(db, client, { full: true });

    // C1 failed mid-thread → watermark NOT advanced, nothing tombstoned (will retry next cycle).
    expect(getChannelByNameOrId(db, WS, "C1")?.last_synced_ts).toBeNull();
    expect(isTombstoned("1000.0000", "C1")).toBe(false);
    // C2 synced fine.
    expect(getChannelByNameOrId(db, WS, "C2")?.last_synced_ts).toBe("3000.0000");
  });

  it("resurrects a tombstoned thread when it reappears in Slack", async () => {
    upsertPreexisting("C1", [storedMsg("1000.0000", "C1", { reply_count: 1, deleted_at: 12345 })]);

    const client = fakeClient({
      history: { C1: [msg("1000.0000", { reply_count: 1 })] },
      replies: {
        "C1:1000.0000": [
          msg("1000.0000", { reply_count: 1 }),
          msg("1001.0000", { thread_ts: "1000.0000" }),
        ],
      },
    });

    await runSync(db, client, { full: true });

    expect(isTombstoned("1000.0000", "C1")).toBe(false);
  });
});
