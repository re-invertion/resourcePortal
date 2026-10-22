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
    },
  });
  if (!policy || (!policy.requireTenantIdentityProvider && policy.allowPlatformLogin !== false)) {
    return;
  }
  if (await isNativeOnly()) return;

  if (!authenticatedIdpId) {
    throw new ForbiddenException("This tenant requires a verified tenant identity provider");
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
