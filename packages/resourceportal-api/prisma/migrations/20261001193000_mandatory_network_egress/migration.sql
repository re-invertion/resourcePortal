-- v0.2.57: private/datacenter egress isolation is a mandatory platform invariant.
-- Heal any legacy disabled row before installing the database-level guard.
UPDATE "PlatformEgressPolicy"
SET
  "enabled" = true,
  "revision" = "revision" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "enabled" = false;

ALTER TABLE "PlatformEgressPolicy"
ADD CONSTRAINT "PlatformEgressPolicy_enabled_mandatory"
CHECK ("enabled" = true);
