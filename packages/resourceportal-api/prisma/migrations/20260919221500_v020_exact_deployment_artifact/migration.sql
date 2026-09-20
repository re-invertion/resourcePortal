-- Persist the digest of the exact rendered Compose document used for Swarm.
-- Nullable for online compatibility; legacy v0.1.x rows are backfilled lazily
-- from their immutable renderedStack (or materialized once from stackConfig).
ALTER TABLE "AppGroupDeployment"
  ADD COLUMN IF NOT EXISTS "renderedStackSha256" VARCHAR(64);
