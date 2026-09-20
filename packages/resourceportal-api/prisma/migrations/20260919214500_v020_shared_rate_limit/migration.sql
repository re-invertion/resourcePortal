-- Shared fixed-window rate limiting for horizontally scaled API replicas.
CREATE TABLE IF NOT EXISTS "ApiRateLimitBucket" (
  "key" VARCHAR(64) NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "resetAt" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiRateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "ApiRateLimitBucket_resetAt_idx"
  ON "ApiRateLimitBucket"("resetAt");
