-- Preserve existing LAN to RP connectivity; prohibit unsolicited RP to LAN by default.
ALTER TABLE "ResourcePortalGate"
  ADD COLUMN "allowLanToRp" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "allowRpToLan" BOOLEAN NOT NULL DEFAULT false;
