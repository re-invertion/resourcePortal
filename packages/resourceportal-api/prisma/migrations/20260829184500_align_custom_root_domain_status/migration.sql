CREATE TYPE "CustomRootDomainVerificationStatus" AS ENUM ('Pending', 'Verified', 'Failed');

UPDATE "CustomRootDomain"
SET "verificationStatus" = 'Failed'
WHERE "verificationStatus" IN ('Invalid', 'Error');

ALTER TABLE "CustomRootDomain"
ALTER COLUMN "verificationStatus" DROP DEFAULT;

ALTER TABLE "CustomRootDomain"
ALTER COLUMN "verificationStatus" TYPE "CustomRootDomainVerificationStatus"
USING "verificationStatus"::"CustomRootDomainVerificationStatus";

ALTER TABLE "CustomRootDomain"
ALTER COLUMN "verificationStatus" SET DEFAULT 'Pending';

DROP INDEX IF EXISTS "CustomRootDomain_tenantId_rootDomain_key";
CREATE UNIQUE INDEX IF NOT EXISTS "CustomRootDomain_rootDomain_key" ON "CustomRootDomain"("rootDomain");
