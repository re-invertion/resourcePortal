import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

/**
 * A safe, read-only native-login decision. "auto" only retires the RP-side
 * inbound federation endpoints when there has never been a configured external
 * IdP or upstream-linked account and no tenant requires the legacy policy.
 * No credentials, identities, membership roles or sessions are rewritten.
 *
 * The hosted ZITADEL login policy still needs separate live certification:
 * RP will reject tokens positively attested as external in native-only mode.
 */
@Injectable()
export class NativeLoginModeService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async isNativeOnly(): Promise<boolean> {
    const mode = this.config.get<string>("RP_NATIVE_LOGIN_ONLY");
    if (mode === "true") return true;
    if (mode !== "auto") return false;
    const issuer = this.config.get<string>("OIDC_ISSUER_URL");
    if (!issuer?.startsWith("https://")) return false;

    // No caching: creating an identity provider out-of-band must never leave
    // a stale decision that grants legacy-provider access.
    const [configuredProviders, linkedAccounts, incomingPolicies, externalSessions] =
      await Promise.all([
        this.prisma.identityProvider.count(),
        this.prisma.userIdentity.count({ where: { identityProviderId: { not: null } } }),
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
      ]);
    return configuredProviders === 0 && linkedAccounts === 0 &&
      incomingPolicies === 0 && externalSessions === 0;
  }
}
