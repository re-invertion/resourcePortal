-- Do not infer verified login provider from historical UserIdentity links.
-- Legacy sessions remain unattributed and cannot bypass a tenant's required IdP policy.
ALTER TABLE "PortalSession" ADD COLUMN "authenticatedIdpId" TEXT;
