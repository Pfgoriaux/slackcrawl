import { afterEach, describe, expect, it } from "bun:test";
import { loadConfig } from "./config";

afterEach(() => {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACKCRAWL_SYNC_INTERVAL;
  delete process.env.SLACKCRAWL_API_KEY;
});

describe("loadConfig()", () => {
  it("rejects a zero sync interval (would sync continuously)", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACKCRAWL_SYNC_INTERVAL = "0s";
    expect(() => loadConfig()).toThrow(/SLACKCRAWL_SYNC_INTERVAL/);
  });

  it("rejects placeholder API keys", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACKCRAWL_API_KEY = "changeme";
    expect(() => loadConfig()).toThrow(/placeholder|too short/);
  });

  it("rejects short API keys", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACKCRAWL_API_KEY = "shortkey";
    expect(() => loadConfig()).toThrow(/too short/);
  });

  it("parses named API keys", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACKCRAWL_API_KEYS =
      "alice:aaaaaaaaaaaaaaaaaaaaaaaa1,ci-bot:bbbbbbbbbbbbbbbbbbbbbbbb2";
    const cfg = loadConfig();
    expect(cfg.apiKeys.map((k) => k.name)).toEqual(["alice", "ci-bot"]);
  });
});
