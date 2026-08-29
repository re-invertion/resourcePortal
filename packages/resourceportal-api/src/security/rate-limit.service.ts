import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

type Bucket = {
  count: number;
  resetAt: number;
};

@Injectable()
export class RateLimitService {
  private readonly buckets = new Map<string, Bucket>();
  private lastCleanupAt = 0;

  constructor(private readonly config: ConfigService) {}

  consume(key: string, now = Date.now()) {
    const windowMs = this.windowSeconds() * 1000;
    const maxRequests = this.maxRequests();
    this.cleanup(now);

    const current = this.buckets.get(key);
    const bucket =
      !current || current.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : current;
    bucket.count += 1;
    this.buckets.set(key, bucket);

    const remaining = Math.max(0, maxRequests - bucket.count);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.resetAt - now) / 1000),
    );

    return {
      allowed: bucket.count <= maxRequests,
      limit: maxRequests,
      remaining,
      resetAt: bucket.resetAt,
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

  private cleanup(now: number) {
    if (now - this.lastCleanupAt < 60_000) {
      return;
    }

    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
    this.lastCleanupAt = now;
  }
}
