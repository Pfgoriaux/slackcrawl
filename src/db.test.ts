import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Message,
  markMessagesDeleted,
  openDB,
  searchMessages,
  upsertChannel,
  upsertMessage,
} from "./db";
import { upsertEmbedding } from "./enrich-db";
import { VecIndex } from "./vec";

const WS = "T-test";
const CH = "C-test";

let db: Database;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slackcrawl-test-"));
  db = openDB(join(dir, "test.db"));
  upsertChannel(db, {
    id: CH,
    workspace_id: WS,
    name: "general",
    is_private: 0,
    is_archived: 0,
    topic: null,
    purpose: null,
    member_count: 2,
    created_at: 1000,
    last_synced_ts: null,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function msg(ts: string, text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: `${WS}:${CH}:${ts}`,
    workspace_id: WS,
    channel_id: CH,
    ts,
    thread_ts: null,
    subtype: null,
    user_id: "U1",
    username: "alice",
    text,
    has_attachments: 0,
    has_files: 0,
    reactions: null,
    reply_count: 0,
    reply_users: null,
    edited_ts: null,
    created_at: Math.floor(parseFloat(ts)),
    deleted_at: null,
    raw_json: null,
    ...overrides,
  };
}

describe("message upsert + FTS", () => {
  it("stores and full-text-searches messages", () => {
    upsertMessage(db, msg("1000.0001", "deploying the frobnicator"));
    upsertMessage(db, msg("1000.0002", "lunch anyone?"));

    const hits = searchMessages(db, "frobnicator", { workspaceId: WS });
    expect(hits.length).toBe(1);
    expect(hits[0].text).toBe("deploying the frobnicator");
  });

  it("updates text on conflict and keeps FTS in sync", () => {
    upsertMessage(db, msg("1000.0001", "initial text"));
    upsertMessage(db, msg("1000.0001", "edited text"));
    expect(searchMessages(db, "initial", { workspaceId: WS }).length).toBe(0);
    expect(searchMessages(db, "edited", { workspaceId: WS }).length).toBe(1);
  });

  it("tombstones messages and resurrects them on re-sync", () => {
    upsertMessage(db, msg("1000.0001", "hello world"));
    markMessagesDeleted(db, [`${WS}:${CH}:1000.0001`]);
    expect(searchMessages(db, "hello", { workspaceId: WS }).length).toBe(0);

    // Re-seeing the message in Slack clears the tombstone.
    upsertMessage(db, msg("1000.0001", "hello world"));
    expect(searchMessages(db, "hello", { workspaceId: WS }).length).toBe(1);
  });

  it("excludes noise subtypes from search", () => {
    upsertMessage(db, msg("1000.0001", "bob joined the channel", { subtype: "channel_join" }));
    expect(searchMessages(db, "joined", { workspaceId: WS }).length).toBe(0);
  });
});

describe("VecIndex over real embeddings", () => {
  it("returns nearest neighbours by cosine similarity", () => {
    upsertMessage(db, msg("1000.0001", "near a"));
    upsertMessage(db, msg("1000.0002", "far b"));
    upsertMessage(db, msg("1000.0003", "opposite c"));

    const float = (v: number[]) => {
      const a = new Float32Array(v.length);
      a.set(v);
      return a;
    };

    upsertEmbedding(db, `${WS}:${CH}:1000.0001`, float([1, 0]), "test-model");
    upsertEmbedding(db, `${WS}:${CH}:1000.0002`, float([0, 1]), "test-model");
    upsertEmbedding(db, `${WS}:${CH}:1000.0003`, float([-1, 0]), "test-model");

    const idx = new VecIndex();
    idx.load(db);
    expect(idx.size).toBe(3);

    const hits = idx.search(float([1, 0.1]), 2);
    expect(hits[0].messageId).toBe(`${WS}:${CH}:1000.0001`);
    expect(hits[1].messageId).toBe(`${WS}:${CH}:1000.0002`);
    // The opposite vector must not make the top-2.
    expect(hits.find((h) => h.messageId.includes("1000.0003"))).toBeUndefined();
  });
});
