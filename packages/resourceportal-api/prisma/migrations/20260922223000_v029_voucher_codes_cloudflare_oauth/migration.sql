-- v0.2.9: encrypted voucher display codes and tenant Cloudflare OAuth.

ALTER TABLE "Voucher"
  ADD COLUMN "codeCiphertext" TEXT;

ALTER TABLE "PlatformDnsIntegration"
  ADD COLUMN "oauthClientId" TEXT,
  ADD COLUMN "oauthClientSecretCiphertext" TEXT;

CREATE TABLE "CloudflareOAuthState" (
  "id" UUID NOT NULL,
  "stateHash" TEXT NOT NULL,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CloudflareOAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CloudflareOAuthState_stateHash_key" ON "CloudflareOAuthState"("stateHash");
CREATE INDEX "CloudflareOAuthState_tenantId_userId_idx" ON "CloudflareOAuthState"("tenantId", "userId");
CREATE INDEX "CloudflareOAuthState_expiresAt_idx" ON "CloudflareOAuthState"("expiresAt");
ALTER TABLE "CloudflareOAuthState"
  ADD CONSTRAINT "CloudflareOAuthState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CloudflareOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CloudflareOAuthConnection" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "accessTokenCiphertext" TEXT NOT NULL,
  "refreshTokenCiphertext" TEXT,
  "accessTokenExpiresAt" TIMESTAMP(3),
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CloudflareOAuthConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CloudflareOAuthConnection_tenantId_userId_key"
  ON "CloudflareOAuthConnection"("tenantId", "userId");
ALTER TABLE "CloudflareOAuthConnection"
  ADD CONSTRAINT "CloudflareOAuthConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CloudflareOAuthConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
