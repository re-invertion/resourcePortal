import { ConfigService } from "@nestjs/config";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { RateLimitService } from "./rate-limit.service";

function config(values: Record<string, string>) {
  return {
    get: <T = string>(key: string, fallback?: T) =>
      (values[key] ?? fallback) as T,
  } as ConfigService;
}

function sharedPrisma() {
  const buckets = new Map<string, { count: number; resetAt: Date }>();
  const queries: Prisma.Sql[] = [];
  const queryRaw = vi.fn((sql: Prisma.Sql) => {
    queries.push(sql);
    const values = sql.values;
    const key = values.find((value) => typeof value === "string" && value.length === 64) as string;
    const dates = values.filter((value): value is Date => value instanceof Date);
    const windowStartedAt = dates[0];
    const proposedResetAt = dates[1];
    if (!key || !windowStartedAt || !proposedResetAt) throw new Error("Unexpected SQL fixture");

    const current = buckets.get(key);
    const next =
      !current || current.resetAt <= windowStartedAt
        ? { count: 1, resetAt: proposedResetAt }
        : { count: current.count + 1, resetAt: current.resetAt };
    buckets.set(key, next);
    return Promise.resolve([next]);
  });
  const prisma = {
    $queryRaw: queryRaw,
    apiRateLimitBucket: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  } as unknown as PrismaService;
  return { prisma, buckets, queries };
}

describe("RateLimitService shared PostgreSQL buckets", () => {
  it("allows requests up to the configured limit", async () => {
    const { prisma } = sharedPrisma();
    const limiter = new RateLimitService(
      config({ API_RATE_LIMIT_MAX: "2", API_RATE_LIMIT_WINDOW_SECONDS: "60" }),
      prisma,
    );

    await expect(limiter.consume("203.0.113.10", 1000)).resolves.toMatchObject({
      allowed: true,
      limit: 2,
      remaining: 1,
    });
    await expect(limiter.consume("203.0.113.10", 1001)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(limiter.consume("203.0.113.10", 1002)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });
  });

  it("shares a bucket across separate API service instances", async () => {
    const { prisma } = sharedPrisma();
    const cfg = config({ API_RATE_LIMIT_MAX: "2", API_RATE_LIMIT_WINDOW_SECONDS: "60" });
    const replicaA = new RateLimitService(cfg, prisma);
    const replicaB = new RateLimitService(cfg, prisma);

    expect((await replicaA.consume("198.51.100.25", 1000)).allowed).toBe(true);
    expect((await replicaB.consume("198.51.100.25", 1001)).allowed).toBe(true);
    expect((await replicaA.consume("198.51.100.25", 1002)).allowed).toBe(false);
  });

  it("uses independent hashed buckets and never persists a raw client IP", async () => {
    const { prisma, buckets, queries } = sharedPrisma();
    const limiter = new RateLimitService(
      config({ API_RATE_LIMIT_MAX: "1", API_RATE_LIMIT_WINDOW_SECONDS: "60" }),
      prisma,
    );

    expect((await limiter.consume("192.0.2.10", 1000)).allowed).toBe(true);
    expect((await limiter.consume("192.0.2.11", 1001)).allowed).toBe(true);
    expect(buckets.size).toBe(2);
    const persistedValues = queries.flatMap((query) => query.values);
    expect(persistedValues).not.toContain("192.0.2.10");
    expect(persistedValues).not.toContain("192.0.2.11");
  });

  it("resets the shared bucket after the configured window", async () => {
    const { prisma } = sharedPrisma();
    const limiter = new RateLimitService(
      config({ API_RATE_LIMIT_MAX: "1", API_RATE_LIMIT_WINDOW_SECONDS: "10" }),
      prisma,
    );

    expect((await limiter.consume("203.0.113.20", 1000)).allowed).toBe(true);
    expect((await limiter.consume("203.0.113.20", 1001)).allowed).toBe(false);
    expect((await limiter.consume("203.0.113.20", 11000)).allowed).toBe(true);
  });

  it("uses an atomic PostgreSQL upsert instead of a process-local Map", async () => {
    const { prisma, queries } = sharedPrisma();
    const limiter = new RateLimitService(config({}), prisma);
    await limiter.consume("203.0.113.30", 1000);
    const text = queries[0]?.strings.join(" ") ?? "";
    expect(text).toContain('INSERT INTO "ApiRateLimitBucket"');
    expect(text).toContain('ON CONFLICT ("key") DO UPDATE');
  });
});
