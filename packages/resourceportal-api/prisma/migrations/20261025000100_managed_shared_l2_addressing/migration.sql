-- Add explicit, independently persisted per-application addressing mode.
-- Existing LAN Attachments retain their DHCP behavior without transformation.
ALTER TABLE "RemoteLanAttachment"
  ADD COLUMN "uplinkMode" VARCHAR(24) NOT NULL DEFAULT 'DedicatedUnnumbered',
  ADD COLUMN "addressMode" VARCHAR(8) NOT NULL DEFAULT 'DHCP',
  ADD COLUMN "configurationRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "staticAddress" VARCHAR(18),
  ADD COLUMN "staticGateway" VARCHAR(15);

ALTER TABLE "ResourcePortalGate"
  ADD COLUMN "observedLan" JSONB,
  ADD COLUMN "observedLanAt" TIMESTAMP(3);

-- Database boundaries are a final defense against malformed API writes.
ALTER TABLE "RemoteLanAttachment"
  ADD CONSTRAINT "RemoteLanAttachment_addressMode_check"
  CHECK ("addressMode" IN ('DHCP','Static')),
  ADD CONSTRAINT "RemoteLanAttachment_uplinkMode_check"
  CHECK ("uplinkMode" IN ('DedicatedUnnumbered','ManagedSharedUplink')),
  ADD CONSTRAINT "RemoteLanAttachment_staticMode_check"
  CHECK (
    ("addressMode" = 'DHCP' AND "staticAddress" IS NULL AND "staticGateway" IS NULL)
    OR ("addressMode" = 'Static' AND "staticAddress" IS NOT NULL AND "staticGateway" IS NOT NULL)
  );
CREATE UNIQUE INDEX "RemoteLanAttachment_gateId_staticAddress_key"
 ON "RemoteLanAttachment" ("gateId", "staticAddress") WHERE "staticAddress" IS NOT NULL;
