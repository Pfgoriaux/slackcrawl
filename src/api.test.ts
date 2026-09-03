import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type WorkspaceRef } from "./api";
import { openDB } from "./db";

let db: Database;
let dir: string;
let server: ReturnType<typeof createServer>;
let base: string;

const KEYS = [
  { name: "alice", key: "alice-secret-key-0123456789" },
  { name: "ci-bot", key: "ci-bot-secret-key-0123456789" },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slackcrawl-api-test-"));
  db = openDB(join(dir, "test.db"));
  const wsRef: WorkspaceRef = { workspaceId: "T-test" };
  server = createServer(db, KEYS, wsRef, () => {}, {
    port: 0,
    host: "127.0.0.1",
    maxLimit: 500,
    isReady: () => true,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth", () => {
  it("rejects /v1/* without a key (401)", async () => {
    const res = await fetch(`${base}/v1/channels`);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong key (401)", async () => {
    const res = await fetch(`${base}/v1/channels`, {
      headers: { Authorization: "Bearer wrong-secret-key-99999999" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a key with wrong length prefix (403-ish → 401, not a crash)", async () => {
    const res = await fetch(`${base}/v1/channels`, {
      headers: { Authorization: "Bearer x" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts every configured key", async () => {
    for (const k of KEYS) {
      const res = await fetch(`${base}/v1/channels`, {
        headers: { Authorization: `Bearer ${k.key}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it("never accepts a digest-style or mangled header", async () => {
    for (const header of [
      `bearer ${KEYS[0].key}`, // wrong scheme case
      `Bearer  ${KEYS[0].key}`, // double space
      KEYS[0].key, // no scheme
    ]) {
      const res = await fetch(`${base}/v1/channels`, {
        headers: { Authorization: header },
      });
      expect(res.status).toBe(401);
    }
  });
});

describe("unauthenticated-by-design endpoints", () => {
  it("/health is public and reports readiness", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; ready: boolean };
    expect(body.status).toBe("ok");
    expect(body.ready).toBe(true);
  });

  it("/v1/schema is public (agent discovery)", async () => {
    const res = await fetch(`${base}/v1/schema`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openapi: string };
    expect(body.openapi).toBe("3.0.3");
  });
});

describe("routes", () => {
  const authed = () => ({ headers: { Authorization: `Bearer ${KEYS[0].key}` } });

  it("POST /v1/sync accepts an empty body and queues", async () => {
    const res = await fetch(`${base}/v1/sync`, { method: "POST", ...authed() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("queued");
  });

  it("unknown /v1 path is a 404, not a 500", async () => {
    const res = await fetch(`${base}/v1/nope`, authed());
    expect(res.status).toBe(404);
  });

  it("invalid FTS query on /v1/search is a 400, not a 500", async () => {
    const res = await fetch(`${base}/v1/search?q=${encodeURIComponent('"unbalanced')}`, authed());
    expect(res.status).toBe(400);
  });
});
