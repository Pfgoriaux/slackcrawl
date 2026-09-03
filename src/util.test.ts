import { describe, expect, it } from "bun:test";
import { int, isFtsQueryError, json, parseDateParam } from "./util";

describe("json()", () => {
  it("sends no CORS headers by default (agent API, not a browser one)", () => {
    delete process.env.SLACKCRAWL_CORS_ORIGIN;
    const res = json({ ok: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("sends CORS headers only when SLACKCRAWL_CORS_ORIGIN is set", () => {
    process.env.SLACKCRAWL_CORS_ORIGIN = "https://app.example.com";
    const res = json({ ok: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    delete process.env.SLACKCRAWL_CORS_ORIGIN;
  });
});

describe("int()", () => {
  it("returns default when absent or invalid", () => {
    expect(int(null, 42)).toBe(42);
    expect(int("", 42)).toBe(42);
    expect(int("abc", 42)).toBe(42);
  });

  it("clamps provided values to [1, max]", () => {
    expect(int("10", 5, 100)).toBe(10);
    expect(int("9999", 5, 100)).toBe(100);
    expect(int("0", 5, 100)).toBe(1);
    expect(int("-5", 5, 100)).toBe(1);
  });

  it("returns parsed value unclamped when no max is given", () => {
    expect(int("7", 5)).toBe(7);
  });
});

describe("isFtsQueryError()", () => {
  it("recognizes every FTS5 query-syntax error SQLite emits", () => {
    expect(isFtsQueryError(new Error('fts5: syntax error near "foo"'))).toBe(true);
    expect(isFtsQueryError(new Error("malformed MATCH expression: [foo]"))).toBe(true);
    expect(isFtsQueryError(new Error("unterminated string"))).toBe(true);
    expect(isFtsQueryError(new Error('unknown special query: ""'))).toBe(true);
  });

  it("rejects non-FTS errors", () => {
    expect(isFtsQueryError(new Error("database is locked"))).toBe(false);
    expect(isFtsQueryError(new Error("no such table: messages"))).toBe(false);
    expect(isFtsQueryError("not an error")).toBe(false);
    expect(isFtsQueryError(null)).toBe(false);
  });
});

describe("parseDateParam()", () => {
  it("parses ISO dates to unix seconds", () => {
    expect(parseDateParam("2026-01-02")).toBe((Date.parse("2026-01-02") / 1000) | 0);
  });

  it("returns undefined for absent or invalid input", () => {
    expect(parseDateParam(null)).toBeUndefined();
    expect(parseDateParam("")).toBeUndefined();
    expect(parseDateParam("not-a-date")).toBeUndefined();
  });
});
