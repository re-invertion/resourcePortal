import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Risk assessment for retiring inbound federation. This is intentionally
 * READ ONLY and cannot claim that a user can actually authenticate locally:
 * a native UserIdentity record is not proof of a working password/passkey.
 */
@Injectable()
export class FederationRetirementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async preflight() {
    const issuer = this.config.get<string>("OIDC_ISSUER_URL")?.replace(/\/$/, "");
    const [
      enabledProviders,
      mandatoryTenantPolicies,
      externalSessions,
      externalIdentities,
    ] = await Promise.all([
      this.prisma.identityProvider.count({ where: { enabled: true } }),
      this.prisma.tenantAuthPolicy.count({
        where: {
          OR: [
            { requireTenantIdentityProvider: true },
            { allowPlatformLogin: false },
          ],
        },
      }),
      this.prisma.portalSession.count({
        where: { authenticatedIdpId: { not: null } },
      }),
      this.prisma.userIdentity.findMany({
        where: { identityProviderId: { not: null } },
        select: { userId: true },
        distinct: ["userId"],
      }),
    ]);
    const users = externalIdentities.map(row => row.userId);
    const nativeLinks = issuer && users.length > 0
      ? await this.prisma.userIdentity.findMany({
        where: {
          userId: { in: users },
          issuer,
          providerType: "zitadel",
          identityProviderId: null,
        },
        select: { userId: true },
        distinct: ["userId"],
      })
      : [];
    const withNativeLinks = new Set(nativeLinks.map(row => row.userId));
    const usersWithoutNativeLink = users.filter(userId => !withNativeLinks.has(userId)).length;
    const blockers: string[] = [];
    if (!issuer) blockers.push("Platform ZITADEL issuer is not configured");
    if (mandatoryTenantPolicies > 0) blockers.push("Tenants require incoming federation");
    if (usersWithoutNativeLink > 0) blockers.push("Federated users lack native identity links");
    if (externalSessions > 0) blockers.push("Federated sessions require revocation");
    if (enabledProviders > 0) blockers.push("Enabled ZITADEL login providers must be unlinked");
    blockers.push("Operator must verify actual native login, account recovery, MFA and break-glass access");
    blockers.push("ZITADEL upstream login policy must be verified before cutover");

    return {
      mode: this.config.get<string>("RP_NATIVE_LOGIN_ONLY") === "true" ? "NativeOnly" : "LegacyCompatible",
      enabledProviders,
      mandatoryTenantPolicies,
      externalSessions,
      federatedUsers: users.length,
      usersWithoutNativeLink,
      needsNativeLoginVerification: users.length,
      safeToCutoverAutomatically: false,
      blockers,
    };
  }
}
