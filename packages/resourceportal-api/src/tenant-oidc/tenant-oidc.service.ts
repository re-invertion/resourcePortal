import {
  ConflictException,
  Optional,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { MembershipStatus, TenantStatus, UserStatus, Prisma } from "@prisma/client";
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
    if (!provider || provider.status === "Deleted") {
      return { tenantId, status: "NotProvisioned", enabled: false };
    }
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

  async provision(tenantId: string, fromAutoRollout = false) {
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
    if (["Disabling", "Disabled", "Deleted"].includes(provider.status)) {
      if (fromAutoRollout) {
        throw new ConflictException("Tenant administrator explicitly disabled automatic OIDC provisioning");
      }
      // Explicit human provisioning is the supported re-enrolment path.
      provider = await this.prisma.tenantOidcProvider.update({
        where: { tenantId },
        data: { status: "Pending", lastErrorCode: null },
      });
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
    // Commit fail-closed state before making any upstream grants. In-transaction
    // disabling would roll back on remote errors and could leave an enabled IdP.
    const claimed = await this.prisma.tenantOidcProvider.updateMany({
      where: { tenantId, status: { notIn: ["Disabling", "Disabled", "Deleted"] } },
      data: { enabled: false, status: "Reconciling", grantsReconciledAt: null },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("Tenant OIDC has been explicitly disabled");
    }
    try {
      // All membership removal paths acquire this same Tenant row lock BEFORE
      // upstream revocation. A reconciliation cannot grant a user whose
      // suspension/deletion is concurrently being committed.
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId}::uuid FOR UPDATE`);
      const provider = await tx.tenantOidcProvider.findUnique({ where: { tenantId } });
      if (!provider?.zitadelProjectId) {
        throw new NotFoundException("Tenant OIDC project is not provisioned");
      }
      if (["Disabling", "Disabled", "Deleted"].includes(provider.status)) {
        throw new ConflictException("Tenant administrator explicitly disabled OIDC");
      }

      // The disabled Reconciling marker has already committed above.
        await this.zitadel.readProject(provider.zitadelProjectId);
        // A tenant project-level role is shared by all of its OAuth clients.
        // Until the exact-client pre-token gate is explicitly certified and
        // enabled, assigning rp.tenant.member to an App Consumer would silently
        // permit every app in that project. Exclude and revoke consumers by
        // default rather than relying on UI-only allowlisting.
        const appConsumerGateCertified =
          this.config?.get<string>("RP_APP_CONSUMER_ACTIONS_V2_ENABLED") === "true" &&
          this.config?.get<string>("RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED") === "true";
        // Flags alone do NOT prove that ZITADEL invokes our webhook. If an
        // operator forgot to bind the execution, project grants would bypass
        // the per-client allowlist for every OAuth application in the tenant.
        // Verify the live target, signing key and exclusive execution first.
        if (appConsumerGateCertified) {
          await this.zitadel.verifyAppConsumerActionsV2Gate();
        }
        const members = await tx.tenantMembership.findMany({
          where: {
            tenantId,
            status: MembershipStatus.Active,
            user: { status: UserStatus.Active },
            ...(appConsumerGateCertified ? {
              OR: [
                { roles: { some: { roleId: "sso-login" } } },
                { groupMemberships: { some: { group: { roles: { some: { roleId: "sso-login" } } } } } },
              ],
            } : {
              // Without a LIVE, certified exact-client pre-token Action,
              // never issue project-wide roles to a newly invited SSO-only
              // identity. Legacy RP members retain pre-#430 access until
              // operator cutover; the installer must block new grant rollout.
              appConsumer: { is: null },
              OR: [
                { roles: { some: { roleId: { not: "sso-login" } } } },
                { groupMemberships: { some: { group: { roles: { some: {
                  roleId: { not: "sso-login" },
                } } } } } },
              ],
            }),
          },
          include: { user: { include: { identities: true } } },
        });
        const allowed = new Set(members.map((member) => member.userId));
        const existing = await tx.tenantOidcGrant.findMany({ where: { tenantId } });

        // Revocation FIRST: stale grants must not survive removal/suspension of membership.
        for (const grant of existing) {
          if (allowed.has(grant.userId)) continue;
          const revokeId = grant.zitadelGrantId ??
            await this.zitadel.findExistingMemberGrant(grant.zitadelUserId, provider.zitadelProjectId);
          if (revokeId) await this.zitadel.revokeMember(grant.zitadelUserId, revokeId);
          await tx.tenantOidcGrant.delete({ where: { id: grant.id } });
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
            await tx.tenantOidcGrant.update({
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

        // A membership/invitation transaction may have invalidated the grant
        // snapshot while remote ZITADEL operations were in progress. Never
        // overwrite NeedsReconciliation with an obsolete successful result.
        const completed = await tx.tenantOidcProvider.updateMany({
          where: { tenantId, enabled: false, status: "Reconciling", grantsReconciledAt: null },
          data: {
            enabled: false,
            status: "GrantsReconciled",
            grantsReconciledAt: new Date(),
            lastErrorCode: null,
          },
        });
        if (completed.count !== 1) {
          throw new ConflictException("Tenant membership changed during grant reconciliation");
        }
      }, { maxWait: 30_000, timeout: 120_000 });
      return this.get(tenantId);
    } catch (error) {
      // Failed transactions release their lock; preserve a concurrent
      // administrator's Disabled state or membership invalidation.
      await this.prisma.tenantOidcProvider.updateMany({
        where: { tenantId, status: "Reconciling" },
        data: { enabled: false, status: "ReconciliationFailed", lastErrorCode: "GRANT_SYNC_FAILED" },
      });
      throw error;
    }
  }

  async verifyIssuerSecurity() {
    await this.zitadel.verifyIssuerSecurity();
  }

  /**
   * Safety monitor for shared-project App Consumer role grants. Even disabling
   * the opt-in flag must remove already-assigned ZITADEL project roles: without
   * a functioning preaccesstoken execution they authorize EVERY OAuth client.
   *
   * Ordinary RP members are never in the revocation set. Reconciliation and
   * membership operations serialize on the tenant row lock. Remote failures
   * preserve tracked intents so the next monitor pass retries revocation.
   */
  async enforceAppConsumerActionsV2Safety() {
    // Include legacy #398 markers during migration, but never rely on them
    // as the sole definition of an SSO principal. Any converted membership
    // carrying sso-login must be protected if the issuer-global pre-token
    // Action disappears; a ZITADEL project role is NOT a client entitlement.
    const consumers = await this.prisma.tenantAppConsumer.findMany({
      select: { tenantId: true, membership: { select: { userId: true } } },
    });
    const ssoMembers = await this.prisma.tenantMembership.findMany({
      where: {
        status: MembershipStatus.Active,
        OR: [
          { roles: { some: { roleId: "sso-login" } } },
          { groupMemberships: { some: { group: { roles: { some: {
            roleId: "sso-login",
          } } } } } },
        ],
      },
      select: { tenantId: true, userId: true },
    });
    const protectedKeys = new Set([
      ...consumers.map((row) => row.tenantId + ":" + row.membership.userId),
      ...ssoMembers.map((row) => row.tenantId + ":" + row.userId),
    ]);
    if (!protectedKeys.size) return { state: "no-consumers", revoked: 0 };
    const userIds = [...new Set([...consumers.map((row) => row.membership.userId),
      ...ssoMembers.map((row) => row.userId)])];
    const assigned = await this.prisma.tenantOidcGrant.findMany({
      where: { userId: { in: userIds } },
      select: { tenantId: true, userId: true },
    });
    const tracked = assigned.filter((row) =>
      protectedKeys.has(row.tenantId + ":" + row.userId));
    if (!tracked.length) return { state: "no-upstream-app-grants", revoked: 0 };

    const enabled =
      this.config?.get<string>("RP_APP_CONSUMER_ACTIONS_V2_ENABLED") === "true" &&
      this.config?.get<string>("RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED") === "true";
    if (enabled) {
      try {
        await this.zitadel.verifyAppConsumerActionsV2Gate();
        return { state: "verified", revoked: 0 };
      } catch {
        // Never log upstream credentials or webhook signatures. Revoke below.
      }
    }
    const byTenant = new Map<string, string[]>();
    for (const row of tracked) {
      byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row.userId]);
    }
    let revoked = 0;
    let failed = 0;
    for (const [tenantId, ids] of byTenant) {
      try {
        // Persist fail-closed RP state BEFORE any upstream I/O and before a
        // transaction could abort; a later success must explicitly reconcile.
        await this.prisma.tenantOidcProvider.updateMany({
          where: { tenantId, status: { notIn: ["Disabling", "Disabled", "Deleted"] } },
          data: {
            enabled: false, status: "NeedsReconciliation",
            grantsReconciledAt: null, lastErrorCode: "APP_CONSUMER_ACTION_BINDING_LOST",
          },
        });
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId}::uuid FOR UPDATE`);
          const provider = await tx.tenantOidcProvider.findUnique({
            where: { tenantId }, include: { tenant: { select: { name: true } } },
          });
          if (!provider?.zitadelProjectId) {
            throw new ServiceUnavailableException("App Consumer upstream project revocation unresolved");
          }
          const grants = await tx.tenantOidcGrant.findMany({
            where: { tenantId, userId: { in: ids } },
          });
          for (const grant of grants) {
            const remoteId = grant.zitadelGrantId ??
              await this.zitadel.findExistingMemberGrant(grant.zitadelUserId, provider.zitadelProjectId);
            if (remoteId) await this.zitadel.revokeMember(grant.zitadelUserId, remoteId);
            await tx.tenantOidcGrant.delete({ where: { id: grant.id } });
            revoked++;
          }
          if (grants.length) {
            // Durable tenant-scoped security evidence, without OAuth client
            // identifiers, subject PII, signing secrets or token contents.
            await tx.auditLogEntry.create({ data: {
              tenantId,
              tenantName: provider.tenant.name,
              actor: "system",
              actorName: "ResourcePortal Security Monitor",
              action: "tenant_oidc.app_consumer_binding_revoked",
              resourceType: "TenantOidcProvider",
              resourceId: tenantId,
              result: "Success",
              changes: { reason: "APP_CONSUMER_ACTION_BINDING_LOST", revokedCount: grants.length },
            } });
          }
        }, { maxWait: 30_000, timeout: 120_000 });
      } catch {
        failed++;
      }
    }
    if (failed) {
      throw new ServiceUnavailableException("App Consumer upstream revocation pending secure recovery");
    }
    return { state: "app-consumer-grants-revoked", revoked };
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
    // Compare-and-swap with the exact certified snapshot. Membership changes
    // atomically clear grantsReconciledAt and set NeedsReconciliation; a
    // late activation must never resurrect the stale grant snapshot.
    const activated = await this.prisma.tenantOidcProvider.updateMany({
      where: {
        tenantId,
        zitadelProjectId: provider.zitadelProjectId,
        enabled: false,
        status: "GrantsReconciled",
        grantsReconciledAt: provider.grantsReconciledAt,
      },
      data: { enabled: true, status: "Active", lastErrorCode: null },
    });
    if (activated.count !== 1) {
      throw new ConflictException("Tenant membership changed before OIDC activation; reconcile grants again");
    }
    return this.get(tenantId);
  }

  async disable(tenantId: string, manualOptOut = true) {
    const provider = await this.prisma.tenantOidcProvider.findUnique({
      where: { tenantId },
    });
    if (!provider) throw new NotFoundException("Tenant OIDC provider not found");

    // Disable state first: this prevents RP from reporting ready during revocation.
    await this.prisma.tenantOidcProvider.update({
      where: { tenantId },
      data: { enabled: false, status: "Disabling", grantsReconciledAt: null,
        autoRolloutLeaseOwner: null, autoRolloutLeaseUntil: null },
    });

    // Wait for in-flight reconciliation under the same Tenant row lock.
    // Otherwise a previously selected member could be granted again after
    // disable already enumerated (and revoked) the old grant rows.
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId}::uuid FOR UPDATE`);
      const grants = await tx.tenantOidcGrant.findMany({ where: { tenantId } });
      for (const grant of grants) {
        const revocationId = grant.zitadelGrantId ??
          await this.zitadel.findExistingMemberGrant(grant.zitadelUserId, provider.zitadelProjectId!);
        if (revocationId) await this.zitadel.revokeMember(grant.zitadelUserId, revocationId);
        await tx.tenantOidcGrant.delete({ where: { id: grant.id } });
      }
      await tx.tenantOidcProvider.update({
        where: { tenantId },
        data: { enabled: false,
          status: manualOptOut ? "Disabled" : "ActivationFailed", lastErrorCode: null },
      });
    }, { maxWait: 30_000, timeout: 120_000 });
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
    // Keep a durable tombstone: deleting the row would cause automatic
    // migration to recreate the project on its next periodic pass.
    await this.prisma.tenantOidcProvider.update({
      where: { tenantId },
      data: { zitadelProjectId: null, issuer: null, enabled: false,
        status: "Deleted", grantsReconciledAt: null, lastErrorCode: null },
    });
    return { deleted: true };
  }

  /**
   * Called before a membership is suspended or deleted.
   * Remote revocation is required to succeed before RP changes authorization state.
   * If RP's subsequent transaction fails, access remains revoked (safe recovery).
   */
  async revokeGrantBeforeMembershipRemoval(
    tenantId: string, userId: string, tx: Prisma.TransactionClient = this.prisma,
  ) {
    const provider = await tx.tenantOidcProvider.findUnique({
      where: { tenantId },
    });
    if (!provider?.zitadelProjectId) return;
    const grant = await tx.tenantOidcGrant.findUnique({
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
    await tx.tenantOidcGrant.delete({ where: { id: grant.id } });
    await tx.tenantOidcProvider.updateMany({
      where: { tenantId, status: { notIn: ["Disabling", "Disabled", "Deleted"] } },
      data: { enabled: false, status: "NeedsReconciliation", grantsReconciledAt: null },
    });
  }

  async markStale(tenantId: string) {
    await this.prisma.tenantOidcProvider.updateMany({
      where: { tenantId, status: { notIn: ["Disabling", "Disabled", "Deleted"] } },
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
