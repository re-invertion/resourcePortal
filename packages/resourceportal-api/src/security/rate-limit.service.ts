import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

type RateLimitRow = {
  count: number;
  resetAt: Date;
};

@Injectable()
export class RateLimitService {
  private lastCleanupAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async consume(key: string, now = Date.now()) {
    const windowMs = this.windowSeconds() * 1000;
    const maxRequests = this.maxRequests();
    const windowStartedAt = new Date(now);
    const proposedResetAt = new Date(now + windowMs);
    const bucketKey = this.hashKey(key);

    const rows = await this.prisma.$queryRaw<RateLimitRow[]>(Prisma.sql`
      INSERT INTO "ApiRateLimitBucket" (
        "key", "windowStartedAt", "resetAt", "count", "updatedAt"
      ) VALUES (
        ${bucketKey}, ${windowStartedAt}, ${proposedResetAt}, 1, NOW()
      )
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "ApiRateLimitBucket"."resetAt" <= ${windowStartedAt}
            THEN 1
          ELSE "ApiRateLimitBucket"."count" + 1
        END,
        "windowStartedAt" = CASE
          WHEN "ApiRateLimitBucket"."resetAt" <= ${windowStartedAt}
            THEN ${windowStartedAt}
          ELSE "ApiRateLimitBucket"."windowStartedAt"
        END,
        "resetAt" = CASE
          WHEN "ApiRateLimitBucket"."resetAt" <= ${windowStartedAt}
            THEN ${proposedResetAt}
          ELSE "ApiRateLimitBucket"."resetAt"
        END,
        "updatedAt" = NOW()
      RETURNING "count", "resetAt"
    `);
    const bucket = rows[0];
    if (!bucket) throw new Error("Rate limiter failed to persist a bucket");

    await this.cleanup(now, windowMs).catch(() => undefined);

    const remaining = Math.max(0, maxRequests - bucket.count);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.resetAt.getTime() - now) / 1000),
    );

    return {
      allowed: bucket.count <= maxRequests,
      limit: maxRequests,
      remaining,
      resetAt: bucket.resetAt.getTime(),
      retryAfterSeconds,
    };
  }

  private maxRequests() {
    return this.positiveInt("API_RATE_LIMIT_MAX", 300);
  }

  private windowSeconds() {
    return this.positiveInt("API_RATE_LIMIT_WINDOW_SECONDS", 60);
  }

  private positiveInt(key: string, fallback: number) {
    const value = Number.parseInt(this.config.get<string>(key, `${fallback}`), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private hashKey(key: string) {
    return createHash("sha256").update(key).digest("hex");
  }

  private async cleanup(now: number, windowMs: number) {
    if (now - this.lastCleanupAt < 60_000) return;
    this.lastCleanupAt = now;
    const staleBefore = new Date(now - Math.max(windowMs * 10, 10 * 60_000));
    await this.prisma.apiRateLimitBucket.deleteMany({
      where: { resetAt: { lt: staleBefore } },
    });
  }
}
