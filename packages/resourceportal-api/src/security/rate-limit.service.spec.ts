import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { RateLimitService } from "./rate-limit.service";

function config(values: Record<string, string>) {
  return {
    get: <T = string>(key: string, fallback?: T) =>
      (values[key] ?? fallback) as T,
  } as ConfigService;
}

describe("RateLimitService", () => {
  it("allows requests up to the configured limit", () => {
    const limiter = new RateLimitService(
      config({ API_RATE_LIMIT_MAX: "2", API_RATE_LIMIT_WINDOW_SECONDS: "60" }),
    );

    expect(limiter.consume("client", 1000)).toMatchObject({
      allowed: true,
      limit: 2,
      remaining: 1,
    });
    expect(limiter.consume("client", 1001)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.consume("client", 1002)).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });
  });

  it("uses independent buckets for independent clients", () => {
    const limiter = new RateLimitService(
      config({ API_RATE_LIMIT_MAX: "1", API_RATE_LIMIT_WINDOW_SECONDS: "60" }),
    );

    expect(limiter.consume("client-a", 1000).allowed).toBe(true);
    expect(limiter.consume("client-a", 1001).allowed).toBe(false);
    expect(limiter.consume("client-b", 1001).allowed).toBe(true);
  });

  it("resets the bucket after the configured window", () => {
    const limiter = new RateLimitService(
      config({ API_RATE_LIMIT_MAX: "1", API_RATE_LIMIT_WINDOW_SECONDS: "10" }),
    );

    expect(limiter.consume("client", 1000).allowed).toBe(true);
    expect(limiter.consume("client", 1001).allowed).toBe(false);
    expect(limiter.consume("client", 11000).allowed).toBe(true);
  });
});
