-- Retirement is a milestone migration. The release must first prove exact-source
-- PostgreSQL and ZITADEL database snapshot restore, old-image readiness,
-- and a failed-upgrade rollback on an isolated real Swarm.
-- Historical migrations remain immutable for reproducible installations.
DROP TABLE "GateNetworkAttachment";

ALTER TABLE "ResourcePortalGate"
  DROP COLUMN "allowLanToRp",
  DROP COLUMN "allowRpToLan",
  DROP COLUMN "applicationAccessMode",
  DROP COLUMN "applicationLanPolicies",
  DROP COLUMN "discoveryRelayVersion",
  DROP COLUMN "discoveryPolicies",
  DROP COLUMN "lanAddresses",
  DROP COLUMN "lanCidrs",
  DROP COLUMN "routeAdvertisementMode",
  DROP COLUMN "bgpLocalAsn",
  DROP COLUMN "bgpRouterAddress",
  DROP COLUMN "bgpRouterAsn",
  DROP COLUMN "bgpSourceAddress",
  DROP COLUMN "bgpHoldTimeSeconds";
