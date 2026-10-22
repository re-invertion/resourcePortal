import { ForbiddenException } from "@nestjs/common";
import { IdentityProviderScope } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Enforces legacy tenant incoming-IdP restrictions at the resource boundary.
 * The authenticatedIdpId must originate in signed, verified authentication
 * evidence attached to the current principal; never use linked identities,
 * client-controlled headers or a provider chosen in the login URL.
 *
 * After native-only cutover historical incoming-provider policies no longer
 * apply. Outbound tenant-issued OIDC clients are separate and unaffected.
 */
export async function assertTenantProviderPolicy(
  prisma: PrismaService,
  tenantId: string,
  authenticatedIdpId: string | null | undefined,
  isNativeOnly: () => Promise<boolean>,
) {
  const policy = await prisma.tenantAuthPolicy.findUnique({
    where: { tenantId },
    select: {
      requireTenantIdentityProvider: true,
      allowPlatformLogin: true,
      allowTenantIdentityProviders: true,
    },
  });
  if (!policy) return;
  const tenantOnly = policy.requireTenantIdentityProvider || policy.allowPlatformLogin === false;
  if (!tenantOnly && policy.allowTenantIdentityProviders !== false) return;
  if (await isNativeOnly()) return;

  // An internally contradictory legacy policy must fail closed. During
  // native-only cutover old inbound policy settings are intentionally retired.
  if (tenantOnly && policy.allowTenantIdentityProviders === false) {
    throw new ForbiddenException("Tenant identity provider login is disabled");
  }
  if (!authenticatedIdpId) {
    if (tenantOnly) {
      throw new ForbiddenException("This tenant requires a verified tenant identity provider");
    }
    return; // Native platform login remains permitted.
  }

  if (policy.allowTenantIdentityProviders === false) {
    // Only a VERIFIED platform IdP may access a tenant that disables incoming
    // tenant IdPs but allows platform login. An IdP from another tenant is not
    // interchangeable with the platform IdP.
    const platformProvider = await prisma.identityProvider.findFirst({
      where: {
        scope: IdentityProviderScope.Platform,
        tenantId: null,
        enabled: true,
        zitadelIdentityProviderId: authenticatedIdpId,
      },
      select: { id: true },
    });
    if (!platformProvider) {
      throw new ForbiddenException("Tenant identity provider login is disabled");
    }
    return;
  }
  const enabledProvider = await prisma.identityProvider.findFirst({
    where: {
      scope: IdentityProviderScope.Tenant,
      tenantId,
      enabled: true,
      zitadelIdentityProviderId: authenticatedIdpId,
    },
    select: { id: true },
  });
  if (!enabledProvider) {
    throw new ForbiddenException("Login did not use an enabled identity provider for this tenant");
  }
}
