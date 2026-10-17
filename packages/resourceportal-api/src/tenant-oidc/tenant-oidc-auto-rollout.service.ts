import { activeFederatedSessionWhere } from "../auth/federated-session-where";
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { MembershipStatus, TenantStatus, UserStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantOidcService } from "./tenant-oidc.service";

/**
 * Incremental, fail-closed rollout. A schema migration does not imply
 * authorization to issue OIDC tokens: live certification remains mandatory.
 *
 * The unprivileged API runs this after schema migration and periodically for new tenants
 * and interrupted attempts. Status and timestamp form a recoverable per-tenant
 * lease so multiple workers cannot provision the same project simultaneously.
 */
@Injectable()
export class TenantOidcAutoRolloutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantOidcAutoRolloutService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly oidc: TenantOidcService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>("TENANT_OIDC_AUTO_ROLLOUT") !== "true") return;
    void this.reconcileOnce();
    const rawInterval = Number(this.config.get<string>("TENANT_OIDC_RECONCILE_INTERVAL_MS") ?? 60_000);
    const intervalMs = Number.isSafeInteger(rawInterval) && rawInterval >= 10_000
      ? rawInterval : 60_000;
    this.timer = setInterval(() => { void this.reconcileOnce(); }, intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async reconcileOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.reconcile();
      this.logger.log(`OIDC auto migration: ${JSON.stringify(result)}`);
    } catch {
      // Never log raw upstream error responses or management tokens.
      this.logger.warn("OIDC auto migration could not finish; retry scheduled");
    } finally {
      this.running = false;
    }
  }

  /** Small, non-PII readiness signal for the official installer. A successful
   * HTTP liveness probe alone is NOT proof that automatic SSO activation finished.
   */
  async readiness(): Promise<{ status: "ready" | "pending" | "blocked" }> {
    if (this.config.get<string>("TENANT_OIDC_AUTO_ROLLOUT") !== "true" ||
        !["auto", "true"].includes(this.config.get<string>("TENANT_OIDC_ACTIVATION_ALLOWED") ?? "")) {
      return { status: "blocked" };
    }
    const [federatedProviders, federatedAccounts, inboundPolicies, federatedSessions,
      activeTenants, enabledTenants] = await Promise.all([
      this.prisma.identityProvider.count(),
      this.prisma.userIdentity.count({ where: { identityProviderId: { not: null } } }),
      this.prisma.tenantAuthPolicy.count({ where: { OR: [
        { requireTenantIdentityProvider: true }, { allowPlatformLogin: false },
      ] } }),
      this.prisma.portalSession.count({ where: activeFederatedSessionWhere(this.config) }),
      this.prisma.tenant.count({ where: { status: TenantStatus.Active } }),
      this.prisma.tenantOidcProvider.count({ where: {
        enabled: true, status: "Active", tenant: { status: TenantStatus.Active },
      } }),
    ]);
    if (federatedProviders || federatedAccounts || inboundPolicies || federatedSessions) {
      return { status: "blocked" };
    }
    if (activeTenants !== enabledTenants) return { status: "pending" };
    try {
      await this.oidc.verifyIssuerSecurity();
    } catch {
      return { status: "blocked" };
    }
    return { status: "ready" };
  }

  async reconcile() {
    if (this.config.get<string>("TENANT_OIDC_AUTO_ROLLOUT") !== "true") {
      return { state: "disabled", attempted: 0, activated: 0 };
    }
    // No previously configured incoming federation can be silently retired.
    const [externalProviders, externalAccounts, inboundPolicies, externalSessions] =
      await Promise.all([
        this.prisma.identityProvider.count(),
        this.prisma.userIdentity.count({ where: { identityProviderId: { not: null } } }),
        this.prisma.tenantAuthPolicy.count({ where: { OR: [
          { requireTenantIdentityProvider: true }, { allowPlatformLogin: false },
        ] } }),
        this.prisma.portalSession.count({ where: activeFederatedSessionWhere(this.config) }),
      ]);
    if (externalProviders || externalAccounts || inboundPolicies || externalSessions) {
      return {
        state: "blocked-inbound-federation", attempted: 0, activated: 0,
        blockerCounts: { externalProviders, externalAccounts, inboundPolicies, externalSessions },
      };
    }
    if (!this.config.get<string>("ZITADEL_MANAGEMENT_TOKEN") ||
        !this.config.get<string>("ZITADEL_ORGANIZATION_ID") ||
        !this.config.get<string>("OIDC_ISSUER_URL")?.startsWith("https://")) {
      return { state: "blocked-zitadel-configuration", attempted: 0, activated: 0 };
    }

    const policy = this.config.get<string>("TENANT_OIDC_ACTIVATION_ALLOWED");
    const activationPermitted = policy === "auto" || policy === "true";
    const tenants = await this.prisma.tenant.findMany({
      where: { status: TenantStatus.Active },
      select: { id: true }, orderBy: { createdAt: "asc" },
    });
    let attempted = 0;
    let prepared = 0;
    let activated = 0;
    let blocked = 0;
    // Keep database leases across BOTH phases: activation must never start
    // until every tenant was prepared without errors, including in replicas.
    const leases: Array<{ tenantId: string; owner: string }> = [];
    const toActivate: string[] = [];
    const enabledNow: string[] = [];
    try {
      for (const tenant of tenants) {
        const tenantId = tenant.id;
        const legacyClients = await this.prisma.oAuthApplication.count({
          where: { tenantId, zitadelProjectId: null },
        });
        if (legacyClients > 0) { blocked++; continue; }
        const active = await this.prisma.tenantOidcProvider.findUnique({ where: { tenantId } });
        if (active?.enabled && active.status === "Active") continue;
        if (active?.status === "GrantsReconciled" && !activationPermitted) continue;

        const members = await this.prisma.tenantMembership.findMany({
          where: { tenantId, status: MembershipStatus.Active, user: { status: UserStatus.Active } },
          select: { user: { select: { identities: {
            select: { issuer: true, providerType: true, identityProviderId: true },
          } } } },
        });
        const issuer = this.config.get<string>("OIDC_ISSUER_URL")!.replace(/\/$/, "");
        if (members.some(({ user }) => !user.identities.some((identity) =>
          identity.providerType === "zitadel" && identity.identityProviderId === null &&
          identity.issuer.replace(/\/$/, "") === issuer,
        ))) { blocked++; continue; }

        await this.prisma.tenantOidcProvider.upsert({
          where: { tenantId }, create: { tenantId, status: "Pending" }, update: {},
        });
        const owner = randomUUID();
        const now = Date.now();
        const claimed = await this.prisma.tenantOidcProvider.updateMany({
          where: { tenantId, enabled: false, OR: [
            { autoRolloutLeaseUntil: null },
            { autoRolloutLeaseUntil: { lt: new Date(now) } },
          ] },
          data: {
            autoRolloutLeaseOwner: owner,
            autoRolloutLeaseUntil: new Date(now + 60 * 60_000),
          },
        });
        if (claimed.count !== 1) { blocked++; continue; }
        leases.push({ tenantId, owner });
        attempted++;
        try {
          const existing = await this.prisma.tenantOidcProvider.findUnique({ where: { tenantId } });
          if (!existing?.zitadelProjectId) await this.oidc.provision(tenantId);
          await this.oidc.reconcileGrants(tenantId);
          prepared++;
          toActivate.push(tenantId);
        } catch {
          blocked++;
          // The low-level service stores a sanitized provider failure status.
        }
      }

      // Fail closed as a cohort. Never give the first tenant active SSO while
      // migration for another tenant was refused, lost its lease or failed.
      if (blocked === 0 && activationPermitted) {
        for (const tenantId of toActivate) {
          try {
            await this.oidc.activate(tenantId, true);
            enabledNow.push(tenantId);
            activated++;
          } catch {
            blocked++;
            break;
          }
        }
        if (blocked > 0 && enabledNow.length) {
          // Compensate the upstream grants, not just the local enabled flag.
          // ZITADEL would otherwise continue issuing tenant tokens after a
          // partially failed cohort even if RP declared the upgrade failed.
          for (const tenantId of enabledNow.reverse()) {
            try {
              await this.oidc.disable(tenantId);
            } catch {
              // If upstream revocation is unavailable, keep the local state
              // blocked; the installer must not report successful activation.
              blocked++;
              await this.prisma.tenantOidcProvider.updateMany({
                where: { tenantId },
                data: {
                  enabled: false,
                  status: "ActivationFailed",
                  lastErrorCode: "COHORT_REVOKE_FAILED",
                },
              });
            }
          }
          activated = 0;
        }
      }
      return {
        state: blocked ? "partial" : activationPermitted ? "active" : "prepared",
        attempted, prepared, activated, blocked,
      };
    } finally {
      for (const lease of leases) {
        await this.prisma.tenantOidcProvider.updateMany({
          where: { tenantId: lease.tenantId, autoRolloutLeaseOwner: lease.owner },
          data: { autoRolloutLeaseOwner: null, autoRolloutLeaseUntil: null },
        });
      }
    }
  }
}
