-- Legacy privileged App Group networking was replaced by tenant Networks and ResourcePortalGate.
-- Refuse a destructive cleanup while any legacy desired state is still present.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AppGroup" WHERE "networkPrivileged" = true) THEN
    RAISE EXCEPTION 'Cannot remove legacy privileged networking while privileged App Groups still exist';
  END IF;

  IF EXISTS (SELECT 1 FROM "InternalPortExposure" LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot remove legacy privileged networking while Internal Port Exposures still exist';
  END IF;

  IF EXISTS (SELECT 1 FROM "PlatformEgressAllowRule" LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot remove legacy privileged networking while private-network egress exceptions still exist';
  END IF;
END
$$;

DROP TABLE "InternalPortExposure";
DROP TABLE "PlatformEgressAllowRule";
ALTER TABLE "AppGroup" DROP COLUMN "networkPrivileged";
