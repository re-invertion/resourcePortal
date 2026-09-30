ALTER TABLE "ResourcePortalGate"
  ADD COLUMN "routeAdvertisementMode" TEXT NOT NULL DEFAULT 'Manual',
  ADD COLUMN "bgpLocalAsn" BIGINT,
  ADD COLUMN "bgpRouterAddress" TEXT,
  ADD COLUMN "bgpRouterAsn" BIGINT,
  ADD COLUMN "bgpSourceAddress" TEXT,
  ADD COLUMN "bgpHoldTimeSeconds" INTEGER NOT NULL DEFAULT 90;
