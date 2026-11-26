-- Separate durable first-registration reservation; never admit pending clients
-- into the existing McpOAuthUpstreamClient trusted identity allowlist.
CREATE TABLE "McpOAuthUpstreamRegistration" (
  "tenantId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "observedClientId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "McpOAuthUpstreamRegistration_pkey" PRIMARY KEY ("tenantId"),
  CONSTRAINT "McpOAuthUpstreamRegistration_status_check" CHECK ("status" IN ('Pending', 'Uncertain', 'Bound')),
  CONSTRAINT "McpOAuthUpstreamRegistration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
