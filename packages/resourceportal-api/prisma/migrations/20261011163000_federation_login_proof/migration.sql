CREATE TABLE "FederationLoginProof" (
  "nonce" VARCHAR(64) NOT NULL,
  "providerId" VARCHAR(256) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "FederationLoginProof_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX "FederationLoginProof_createdAt_idx"
ON "FederationLoginProof"("createdAt");
