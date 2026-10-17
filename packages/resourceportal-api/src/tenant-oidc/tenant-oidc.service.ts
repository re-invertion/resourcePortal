import {
  ConflictException,
  Optional,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { MembershipStatus, TenantStatus, UserStatus } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { ZitadelTenantProjectService } from "./zitadel-tenant-project.service";

@Injectable()
export class TenantOidcService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zitadel: ZitadelTenantProjectService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async get(tenantId: string) {
    await this.requireActiveTenant(tenantId);
    const provider = await this.prisma.tenantOidcProvider.findUnique({
      where: { tenantId },
      include: { _count: { select: { grants: true } } },
    });
    if (!provider) return { tenantId, status: "NotProvisioned", enabled: false };
    return {
      tenantId,
      status: provider.status,
      enabled: provider.enabled,
      projectId: provider.zitadelProjectId,
      issuer: provider.issuer,
      grantsReconciledAt: provider.grantsReconciledAt,
      grantCount: provider._count.grants,
      lastErrorCode: provider.lastErrorCode,
    };
  }

  async provision(tenantId: string) {
    await this.requireActiveTenant(tenantId);
    // The service never enables a tenant IdP based on an unverified project alone.
    let provider = await this.prisma.tenantOidcProvider.upsert({
      where: { tenantId },
      create: { tenantId, status: "Pending" },
      update: {},
    });
    if (provider.enabled) {
      throw new ConflictException("Disable the tenant IdP before changing its security configuration");
    }

    try {
      if (!provider.zitadelProjectId) {
        // A partially completed request must fail closed; never advertise the project here.
        const projectId = await this.zitadel.findExistingProjectForTenant(tenantId)
          ?? await this.zitadel.createProject(tenantId);
        provider = await this.prisma.tenantOidcProvider.update({
          where: { tenantId },
          data: { zitadelProjectId: projectId, status: "Provisioning", lastErrorCode: null },
        });
      }

      await this.zitadel.readProject(provider.zitadelProjectId!);
      await this.zitadel.ensureMemberRole(provider.zitadelProjectId!);
      await this.prisma.tenantOidcProvider.update({
        where: { tenantId },
        data: {
          issuer: this.zitadel.issuer,
          status: "PendingGrants",
          enabled: false,
          lastErrorCode: null,
        },
      });
      return this.get(tenantId);
    } catch (error) {
      await this.prisma.tenantOidcProvider.update({
        where: { tenantId },
        data: { enabled: false, status: "ProvisioningFailed", lastErrorCode: "ZITADEL_PROVISION_FAILED" },
      });
      throw error;
    }
  }

  async reconcileGrants(tenantId: string) {
    await this.requireActiveTenant(tenantId);
    const provider = await this.prisma.tenantOidcProvider.findUnique({ where: { tenantId } });
    if (!provider?.zitadelProjectId) {
      throw new NotFoundException("Tenant OIDC project is not provisioned");
    }

    // No client can be activated while any membership has not been reconciled.
    await this.prisma.tenantOidcProvider.update({
      where: { tenantId },
      data: { enabled: false, status: "Reconciling", grantsReconciledAt: null },
    });
    try {
      await this.zitadel.readProject(provider.zitadelProjectId);
      const members = await this.prisma.tenantMembership.findMany({
        where: {
          tenantId,
          status: MembershipStatus.Active,
          user: { status: UserStatus.Active },
        },
        include: { user: { include: { identities: true } } },
      });
      const allowed = new Set(members.map((member) => member.userId));
      const existing = await this.prisma.tenantOidcGrant.findMany({ where: { tenantId } });

      // Revocation FIRST: stale grants must not survive removal/suspension of membership.
      for (const grant of existing) {
        if (allowed.has(grant.userId)) continue;
        const revokeId = grant.zitadelGrantId ??
          await this.zitadel.findExistingMemberGrant(grant.zitadelUserId, provider.zitadelProjectId);
        if (revokeId) await this.zitadel.revokeMember(grant.zitadelUserId, revokeId);
        await this.prisma.tenantOidcGrant.delete({ where: { id: grant.id } });
      }

      for (const member of members) {
        const identity = member.user.identities.find(
          (row) => row.providerType === "zitadel" &&
            row.issuer.replace(/\/$/, "") === this.zitadel.issuer &&
            row.identityProviderId === null,
        );
        if (!identity) {
          throw new ServiceUnavailableException(
            "Tenant member lacks verified native ZITADEL identity; reconciliation blocked",
          );
        }
        const grant = existing.find((row) => row.userId === member.userId);
        if (grant?.zitadelUserId !== undefined && grant.zitadelUserId !== identity.externalSubject) {
          throw new ServiceUnavailableException("Mismatched ZITADEL user grant requires recovery");
        }
        if (grant?.zitadelGrantId) {
          await this.zitadel.verifyMemberGrant(identity.externalSubject, grant.zitadelGrantId, provider.zitadelProjectId);
          continue;
        }

        // Persist a recoverable intent BEFORE creating upstream authorization.
        // If the process dies after ZITADEL succeeds, next reconciliation finds
        // the remote assignment and fills its existing row instead of duplicating.
        const pending = grant ?? await this.prisma.tenantOidcGrant.create({
          data: { tenantId, userId: member.userId,
            zitadelUserId: identity.externalSubject, status: "Pending" },
        });
        const alreadyAssigned = await this.zitadel.findExistingMemberGrant(
          identity.externalSubject, provider.zitadelProjectId,
        );
        const grantId = alreadyAssigned ?? await this.zitadel.assignMember(
          identity.externalSubject, provider.zitadelProjectId,
        );
        try {
          await this.prisma.tenantOidcGrant.update({
            where: { id: pending.id },
            data: { zitadelGrantId: grantId, status: "Active" },
          });
        } catch (error) {
          // No successful RP authorization until local state is committed.
          // For new grants try immediate compensation; if it fails, the durable
          // Pending intent and upstream search make a later retry safe.
          if (!alreadyAssigned) {
            try { await this.zitadel.revokeMember(identity.externalSubject, grantId); }
            catch { /* Fail-closed: Pending intent survives for recovery. */ }
          }
          throw error;
        }
      }

      await this.prisma.tenantOidcProvider.update({
        where: { tenantId },
        data: {
          enabled: false,
          status: "GrantsReconciled",
          grantsReconciledAt: new Date(),
          lastErrorCode: null,
        },
      });
      return this.get(tenantId);
    } catch (error) {
      await this.prisma.tenantOidcProvider.update({
        where: { tenantId },
        data: { enabled: false, status: "ReconciliationFailed", lastErrorCode: "GRANT_SYNC_FAILED" },
      });
      throw error;
    }
  }

  async verifyIssuerSecurity() {
    await this.zitadel.verifyIssuerSecurity();
  }

  async activate(tenantId: string, fromAutoRollout = false) {
    // "auto" is allowed only in the built-in rollout path. An explicit "false"
    // remains a kill switch; neither tenant API nor background bootstrap can
    // turn on an unverified issuer or bypass the tenant/grant checks.
    const mode = this.config?.get<string>("TENANT_OIDC_ACTIVATION_ALLOWED");
    if (mode !== "true" && !(mode === "auto" && fromAutoRollout &&
        this.config?.get<string>("TENANT_OIDC_AUTO_ROLLOUT") === "true")) {
      throw new ServiceUnavailableException("Tenant OIDC activation is disabled until rollout verification");
    }
    await this.zitadel.verifyIssuerSecurity();
    const legacy = await this.prisma.oAuthApplication.count({
      where: { tenantId, zitadelProjectId: null },
    });
    if (legacy) {
      throw new ConflictException("Legacy platform-project OAuth clients require migration before activation");
    }
    await this.reconcileGrants(tenantId);
    const provider = await this.prisma.tenantOidcProvider.findUnique({ where: { tenantId } });
    if (!provider?.zitadelProjectId || !provider.grantsReconciledAt ||
        provider.status !== "GrantsReconciled") {
      throw new ServiceUnavailableException("Tenant OIDC role reconciliation is incomplete");
    }
    await this.zitadel.readProject(provider.zitadelProjectId);
    await this.prisma.tenantOidcProvider.update({
      where: { tenantId },
      data: { enabled: true, status: "Active", lastErrorCode: null },
    });
    return this.get(tenantId);
  }

  async disable(tenantId: string) {
    const provider = await this.prisma.tenantOidcProvider.findUnique({
      where: { tenantId },
    });
    if (!provider) throw new NotFoundException("Tenant OIDC provider not found");

    // Disable state first: this prevents RP from reporting ready during revocation.
    await this.prisma.tenantOidcProvider.update({
      where: { tenantId },
      data: { enabled: false, status: "Disabling", grantsReconciledAt: null },
    });

    const grants = await this.prisma.tenantOidcGrant.findMany({ where: { tenantId } });
    for (const grant of grants) {
      const revocationId = grant.zitadelGrantId ??
        await this.zitadel.findExistingMemberGrant(grant.zitadelUserId, provider.zitadelProjectId!);
      if (revocationId) await this.zitadel.revokeMember(grant.zitadelUserId, revocationId);
      await this.prisma.tenantOidcGrant.delete({ where: { id: grant.id } });
    }
    await this.prisma.tenantOidcProvider.update({
      where: { tenantId },
      data: { enabled: false, status: "Disabled", lastErrorCode: null },
    });
    return this.get(tenantId);
  }

  async delete(tenantId: string) {
    const provider = await this.prisma.tenantOidcProvider.findUnique({ where: { tenantId } });
    if (!provider) throw new NotFoundException("Tenant OIDC provider not found");
    // If provisioning never created a tenant project, legacy shared-project
    // applications are NOT dependencies of this provider. Never widen the
    // query by passing "undefined" as a Prisma project filter.
    if (provider.zitadelProjectId) {
      const dependentClients = await this.prisma.oAuthApplication.count({
        where: { tenantId, zitadelProjectId: provider.zitadelProjectId },
      });
      if (dependentClients > 0) {
        throw new ConflictException("Remove tenant OIDC clients first");
      }
    }
    await this.disable(tenantId);
    if (provider.zitadelProjectId) await this.zitadel.deleteProject(provider.zitadelProjectId);
    await this.prisma.tenantOidcProvider.delete({ where: { tenantId } });
    return { deleted: true };
  }

  /**
   * Called before a membership is suspended or deleted.
   * Remote revocation is required to succeed before RP changes authorization state.
   * If RP's subsequent transaction fails, access remains revoked (safe recovery).
   */
  async revokeGrantBeforeMembershipRemoval(tenantId: string, userId: string) {
    const provider = await this.prisma.tenantOidcProvider.findUnique({
      where: { tenantId },
    });
    if (!provider?.zitadelProjectId) return;
    const grant = await this.prisma.tenantOidcGrant.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    if (!grant) {
      if (provider.enabled) {
        throw new ServiceUnavailableException(
          "Tenant IdP has an untracked grant; revocation must be verified first",
        );
      }
      return;
    }
    const revocationId = grant.zitadelGrantId ??
      await this.zitadel.findExistingMemberGrant(grant.zitadelUserId, provider.zitadelProjectId);
    if (revocationId) await this.zitadel.revokeMember(grant.zitadelUserId, revocationId);
    await this.prisma.tenantOidcGrant.delete({ where: { id: grant.id } });
    await this.markStale(tenantId);
  }

  async markStale(tenantId: string) {
    await this.prisma.tenantOidcProvider.updateMany({
      where: { tenantId },
      data: { enabled: false, status: "NeedsReconciliation", grantsReconciledAt: null },
    });
  }

  private async requireActiveTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");
    if (tenant.status !== TenantStatus.Active) {
      throw new ConflictException("Tenant is not active");
    }
  }
}
