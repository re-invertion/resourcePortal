import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { MembershipStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TenantMcpSettingsService } from "./tenant-mcp-settings.service";

function fixture() {
  const tx = {
    tenantMcpSettings: { upsert: vi.fn().mockResolvedValue({}) },
    tenantMcpMemberAccess: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: "tenant-id", name: "Tenant" }) },
    tenantMcpSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    tenantMcpMemberAccess: {},
    tenantMembership: {
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue({ id: "membership-id", status: MembershipStatus.Active }),
    },
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => Promise.resolve(callback(tx))),
  };
  const config = {
    get: vi.fn((key: string) => {
      if (key === "OIDC_ISSUER_URL") return "https://auth.example.com";
      if (key === "ZITADEL_PROJECT_ID") return "project-id";
      if (key === "ZITADEL_ORGANIZATION_ID") return "org-id";
      return undefined;
    }),
  };
  const oidc = {
    getDiscovery: vi.fn().mockResolvedValue({ registrationEndpoint: "https://auth.example.com/oauth/v2/register" }),
  };
  return {
    service: new TenantMcpSettingsService(prisma as never, config as never, oidc as never),
    prisma,
    tx,
    oidc,
  };
}

const actor = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "admin@example.com",
  displayName: "Tenant Admin",
  status: "Active" as const,
};

describe("TenantMcpSettingsService", () => {
  it("defaults MCP to disabled and reports OAuth discovery capability", async () => {
    const { service } = fixture();
    const result = await service.getSettings("22222222-2222-4222-8222-222222222222");
    expect(result).toMatchObject({
      enabled: false,
      accessMode: "SelectedMembers",
      allowedMembershipIds: [],
      oauth: {
        issuer: "https://auth.example.com",
        discoveryAvailable: true,
        dynamicClientRegistrationAvailable: true,
      },
    });
    expect(result.oauth.scopes).toContain("urn:zitadel:iam:org:project:id:project-id:aud");
  });

  it("atomically saves selected-member access and audits the change", async () => {
    const { service, prisma, tx } = fixture();
    prisma.tenantMcpSettings.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        enabled: true,
        accessMode: "SelectedMembers",
        updatedAt: new Date(),
        allowedMembers: [],
      });

    await service.updateSettings(
      "22222222-2222-4222-8222-222222222222",
      {
        enabled: true,
        accessMode: "SelectedMembers",
        allowedMembershipIds: ["11111111-1111-4111-8111-111111111111"],
      },
      actor,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.tenantMcpSettings.upsert).toHaveBeenCalledWith({
      where: { tenantId: "22222222-2222-4222-8222-222222222222" },
      create: {
        tenantId: "22222222-2222-4222-8222-222222222222",
        enabled: true,
        accessMode: "SelectedMembers",
        updatedBy: actor.id,
      },
      update: { enabled: true, accessMode: "SelectedMembers", updatedBy: actor.id },
    });
    expect(tx.tenantMcpMemberAccess.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: "22222222-2222-4222-8222-222222222222", membershipId: "11111111-1111-4111-8111-111111111111" }],
      skipDuplicates: true,
    });
    expect(tx.auditLogEntry.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tx.auditLogEntry.create.mock.calls[0]?.[0])).toContain(
      '"action":"tenant.mcp.settings.update"',
    );
    expect(JSON.stringify(tx.auditLogEntry.create.mock.calls[0]?.[0])).toContain(
      `"actor":"${actor.id}"`,
    );
  });

  it("rejects an allow-list membership from another tenant", async () => {
    const { service, prisma } = fixture();
    prisma.tenantMembership.count.mockResolvedValue(0);
    await expect(service.updateSettings(
      "22222222-2222-4222-8222-222222222222",
      { enabled: true, accessMode: "SelectedMembers", allowedMembershipIds: ["11111111-1111-4111-8111-111111111111"] },
      actor,
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it("enforces disabled, active membership and selected-member access", async () => {
    const { service, prisma } = fixture();
    prisma.tenantMcpSettings.findUnique.mockResolvedValue({ enabled: false, accessMode: "SelectedMembers", allowedMembers: [] });
    await expect(service.assertUserCanUseMcp("tenant-id", "user-id")).rejects.toBeInstanceOf(ForbiddenException);

    prisma.tenantMcpSettings.findUnique.mockResolvedValue({ enabled: true, accessMode: "SelectedMembers", allowedMembers: [] });
    await expect(service.assertUserCanUseMcp("tenant-id", "user-id")).rejects.toBeInstanceOf(ForbiddenException);

    prisma.tenantMcpSettings.findUnique.mockResolvedValue({ enabled: true, accessMode: "SelectedMembers", allowedMembers: [{ membershipId: "membership-id" }] });
    await expect(service.assertUserCanUseMcp("tenant-id", "user-id")).resolves.toEqual({ id: "membership-id", status: MembershipStatus.Active });
  });

  it("allows any active member when access mode is AllMembers", async () => {
    const { service, prisma } = fixture();
    prisma.tenantMcpSettings.findUnique.mockResolvedValue({ enabled: true, accessMode: "AllMembers", allowedMembers: [] });
    await expect(service.assertUserCanUseMcp("tenant-id", "user-id")).resolves.toMatchObject({ id: "membership-id" });
  });
});
