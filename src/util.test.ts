import { describe, expect, it } from "bun:test";
import { int, parseDateParam } from "./util";

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
