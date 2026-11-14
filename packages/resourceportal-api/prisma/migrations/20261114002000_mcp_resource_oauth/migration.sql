-- Resource-specific OAuth 2.1 tokens for RP tenant MCP (issue #442).
-- Additive: old ZITADEL tokens and all existing sessions remain untouched for rollback.
CREATE TABLE "McpOAuthClient" (
  "id" TEXT NOT NULL,
  "redirectUris" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpOAuthCode" (
  "codeHash" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "resource" TEXT NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "codeChallenge" TEXT NOT NULL,
  "authenticatedIdpId" TEXT,
  "scope" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpOAuthCode_pkey" PRIMARY KEY ("codeHash"),
  CONSTRAINT "McpOAuthCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "McpOAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "McpOAuthCode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "McpOAuthCode_expiresAt_idx" ON "McpOAuthCode"("expiresAt");

CREATE TABLE "McpOAuthPendingConsent" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "codeChallenge" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpOAuthPendingConsent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpOAuthPendingConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "McpOAuthPendingConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "McpOAuthPendingConsent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "McpOAuthPendingConsent_expiresAt_idx" ON "McpOAuthPendingConsent"("expiresAt");

CREATE TABLE "McpOAuthGrant" (
  "id" UUID NOT NULL,
  "clientId" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "resource" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "authenticatedIdpId" TEXT,
  "accessTokenHash" TEXT NOT NULL,
  "refreshTokenHash" TEXT,
  "accessExpiresAt" TIMESTAMP(3) NOT NULL,
  "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpOAuthGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpOAuthGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "McpOAuthGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "McpOAuthGrant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "McpOAuthGrant_accessTokenHash_key" ON "McpOAuthGrant"("accessTokenHash");
CREATE UNIQUE INDEX "McpOAuthGrant_refreshTokenHash_key" ON "McpOAuthGrant"("refreshTokenHash");
CREATE INDEX "McpOAuthGrant_tenantId_userId_idx" ON "McpOAuthGrant"("tenantId", "userId");
CREATE INDEX "McpOAuthGrant_refreshExpiresAt_idx" ON "McpOAuthGrant"("refreshExpiresAt");
