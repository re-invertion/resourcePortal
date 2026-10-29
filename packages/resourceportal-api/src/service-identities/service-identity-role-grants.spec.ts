import { ForbiddenException } from "@nestjs/common";
import { MembershipStatus, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import type { AuthenticatedUser } from "../auth/types";
import { ServiceIdentitiesService } from "./service-identities.service";
import { ServiceIdentityCredentialsService } from "./service-identity-credentials.service";
import type { ZitadelServiceIdentityService } from "./zitadel-service-identity.service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const identityId = "22222222-2222-4222-8222-222222222222";
const actor: AuthenticatedUser = {
  id: "33333333-3333-4333-8333-333333333333",
  displayName: "Tenant Admin",
  email: "admin@example.test",
  status: UserStatus.Active,
};
const rolePermissions: Record<string, string[]> = {
  "tenant-owner": ["*"],
  "tenant-admin": ["tenant.read", "service_identity.create", "service_identity.update", "service_identity.delete"],
  viewer: ["tenant.read"],
  "other-power": ["tenant.settings.update"],
};

function fixture(input: {
  actorRoles?: string[];
  groupRoles?: string[];
  targetRoles?: string[];
  memberStatus?: MembershipStatus | null;
} = {}) {
  const actorRoles = input.actorRoles ?? ["tenant-admin"];
  const targetRoles = input.targetRoles ?? ["tenant-owner"];
  const bindings = (roleId: string) =>
    (rolePermissions[roleId] ?? []).map((permissionId) => ({ permissionId }));
  const tenantMembership = {
    findUnique: vi.fn().mockImplementation(() => input.memberStatus === null ? null : ({
      status: input.memberStatus ?? MembershipStatus.Active,
      roles: actorRoles.map((id) => ({ role: { id, permissionBindings: bindings(id) } })),
      groupMemberships: (input.groupRoles ?? []).map((id) => ({
        group: { roles: [{ role: { id, permissionBindings: bindings(id) } }] },
      })),
    })),
  };
  const role = {
    findMany: vi.fn().mockImplementation((args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.filter((id) => id in rolePermissions).map((id) => ({
        id, permissionBindings: bindings(id),
      }))),
  };
  const record = {
    id: identityId, tenantId, name: "automation", description: null, status: "Active",
    zitadelUserId: "remote-1", clientId: "client-1", clientSecretCiphertext: "encrypted",
    createdBy: actor.id, updatedBy: actor.id, createdAt: new Date(), updatedAt: new Date(),
    roles: targetRoles.map((id) => ({
      role: { id, name: id, permissions: rolePermissions[id] ?? [] },
    })),
  };
  const serviceIdentity = {
    findFirst: vi.fn().mockResolvedValue(record),
    create: vi.fn().mockResolvedValue(record),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    update: vi.fn().mockResolvedValue(record),
  };
  const serviceIdentityRole = {
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const prismaShape = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: tenantId, name: "tenant" }) },
    tenantMembership, role, serviceIdentity, serviceIdentityRole,
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaShape)),
  };
  const prisma = prismaShape as unknown as PrismaService;
  const encryption = { encrypt: vi.fn().mockReturnValue("encrypted") } as unknown as EncryptionService;
  const zitadelShape = {
    create: vi.fn().mockResolvedValue({ userId: "remote-1", clientId: "client-1", clientSecret: "secret" }),
    update: vi.fn().mockResolvedValue(undefined),
    setActive: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    rotateSecret: vi.fn().mockResolvedValue("new-secret"),
  };
  const zitadel = zitadelShape as unknown as ZitadelServiceIdentityService;
  const service = new ServiceIdentitiesService(prisma, encryption, zitadel);
  const credentials = new ServiceIdentityCredentialsService(prisma, encryption, zitadel, service);
  return { service, credentials, tenantMembership, role, serviceIdentity, serviceIdentityRole,
    prismaShape, zitadelShape };
}

describe("Service Identity role grant authorization (#321)", () => {
  it("rejects tenant-admin creating an owner-privileged machine principal before external account creation", async () => {
    const { service, zitadelShape, serviceIdentity } = fixture();
    await expect(service.create(tenantId, { name: "escalation", roleIds: ["tenant-owner"] }, actor))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(zitadelShape.create).not.toHaveBeenCalled();
    expect(serviceIdentity.create).not.toHaveBeenCalled();
  });

  it("rejects granting a role with any permission not held by the actor", async () => {
    const { service, zitadelShape } = fixture();
    await expect(service.create(tenantId, { name: "escalation", roleIds: ["other-power"] }, actor))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(zitadelShape.create).not.toHaveBeenCalled();
  });

  it("rejects privilege escalation on update and existing owner credential rotation", async () => {
    const { service, credentials, zitadelShape, serviceIdentity } = fixture();
    await expect(service.update(tenantId, identityId, { roleIds: ["viewer"] }, actor))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(tenantId, identityId, { name: "renamed" }, actor))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.delete(tenantId, identityId, actor))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(credentials.rotateTenant(tenantId, identityId, actor))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(zitadelShape.update).not.toHaveBeenCalled();
    expect(zitadelShape.disable).not.toHaveBeenCalled();
    expect(zitadelShape.rotateSecret).not.toHaveBeenCalled();
    expect(serviceIdentity.updateMany).not.toHaveBeenCalled();
  });

  it("rejects tenant-admin updating a low-privilege identity into a wildcard identity", async () => {
    const { service, serviceIdentityRole } = fixture({ targetRoles: ["viewer"] });
    await expect(service.update(tenantId, identityId, { roleIds: ["tenant-owner"] }, actor))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(serviceIdentityRole.deleteMany).not.toHaveBeenCalled();
  });

  it("accepts a delegated viewer grant by a tenant admin, with authorization checked in the transaction", async () => {
    const { service, serviceIdentity, tenantMembership } = fixture({ targetRoles: ["viewer"] });
    await expect(service.create(tenantId, { name: "viewer-bot", roleIds: ["viewer"] }, actor))
      .resolves.toMatchObject({ clientId: "client-1" });
    expect(tenantMembership.findUnique).toHaveBeenCalledTimes(2);
    expect(serviceIdentity.create).toHaveBeenCalledOnce();
    expect(tenantMembership.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_tenantId: { userId: actor.id, tenantId } },
      }),
    );
  });

  it("permits owner-authorized wildcard grants and existing-owner mutation", async () => {
    const { service, serviceIdentity } = fixture({ actorRoles: ["tenant-owner"] });
    await expect(service.create(tenantId, { name: "owner-bot", roleIds: ["tenant-owner"] }, actor))
      .resolves.toMatchObject({ clientId: "client-1" });
    await expect(service.update(tenantId, identityId, { status: "Suspended" }, actor))
      .resolves.toMatchObject({ id: identityId });
    expect(serviceIdentity.updateMany).toHaveBeenCalledOnce();
  });

  it("accepts an effective group-derived permission but not inactive or absent tenant memberships", async () => {
    const delegated = fixture({ actorRoles: ["viewer"], groupRoles: ["tenant-admin"], targetRoles: ["viewer"] });
    await expect(delegated.service.assertCanManageIdentity(tenantId, identityId, actor))
      .resolves.toBeUndefined();
    const missing = fixture({ memberStatus: null, targetRoles: ["viewer"] });
    await expect(missing.service.create(tenantId, { name: "denied", roleIds: ["viewer"] }, actor))
      .rejects.toBeInstanceOf(ForbiddenException);
    const suspended = fixture({ memberStatus: MembershipStatus.Suspended, targetRoles: ["viewer"] });
    await expect(suspended.service.create(tenantId, { name: "denied", roleIds: ["viewer"] }, actor))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});
