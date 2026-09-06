CREATE TYPE "InstallerEnrollmentRole" AS ENUM ('Worker', 'Manager');

CREATE TABLE "InstallerEnrollment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tokenHash" TEXT NOT NULL,
    "role" "InstallerEnrollmentRole" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "nodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InstallerEnrollment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstallerEnrollment_tokenHash_key"
ON "InstallerEnrollment"("tokenHash");

CREATE INDEX "InstallerEnrollment_role_expiresAt_consumedAt_idx"
ON "InstallerEnrollment"("role", "expiresAt", "consumedAt");
