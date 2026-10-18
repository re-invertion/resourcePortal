-- Additive opt-in configuration: existing Site VPNs retain their settings.
ALTER TABLE "ResourcePortalGate"
  ADD COLUMN "applicationAccessMode" TEXT NOT NULL DEFAULT 'Legacy',
  ADD COLUMN "applicationLanPolicies" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "discoveryRelayVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "discoveryPolicies" JSONB NOT NULL DEFAULT '[]'::jsonb;
