import { BridgeError } from "@bridge/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "./http.js";

/**
 * The limiter's logic, tested directly.
 *
 * The login test proves the limiter is wired in, but it costs fifteen scrypt
 * hashes to do it. The rules themselves are pure and belong here, where they
 * can be checked exactly and in microseconds.
 */
afterEach(() => vi.useRealTimers());

describe("createRateLimiter", () => {
  it("allows exactly the limit, then refuses", () => {
    const check = createRateLimiter(3, 60_000);

    expect(() => {
      check("a");
      check("a");
      check("a");
    }).not.toThrow();
    expect(() => check("a")).toThrow(BridgeError);
  });

  it("counts each key separately, so one account cannot lock out another", () => {
    const check = createRateLimiter(1, 60_000);

    check("alice");
    expect(() => check("bob")).not.toThrow();
    expect(() => check("alice")).toThrow();
  });

  it("forgets once the window passes", () => {
    vi.useFakeTimers();
    const check = createRateLimiter(1, 1000);

    check("a");
    expect(() => check("a")).toThrow();

    vi.advanceTimersByTime(1001);
    expect(() => check("a")).not.toThrow();
  });

  it("reports rate_limited so the API answers 429", () => {
    const check = createRateLimiter(1, 60_000);
    check("a");

    try {
      check("a");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("rate_limited");
    }
  });
});
