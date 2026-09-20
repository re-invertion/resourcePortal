-- v0.2 separates desired runtime configuration from the last successfully
-- observed Docker Swarm state. All columns are nullable/additive so upgrade
-- from the supported v0.1.x releases remains online-compatible.
ALTER TABLE "AppGroup"
  ADD COLUMN IF NOT EXISTS "lastObservedAt" TIMESTAMP(3);

ALTER TABLE "SingleApp"
  ADD COLUMN IF NOT EXISTS "observedDesiredReplicas" INTEGER,
  ADD COLUMN IF NOT EXISTS "observedImage" TEXT,
  ADD COLUMN IF NOT EXISTS "observedAt" TIMESTAMP(3);
