import { NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TenantsService } from "./tenants.service";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function fixture(expiresAt = new Date(Date.now() + 60_000)) {
  const token = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
  const invitation = {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    email: "alice@example.com",
    tokenHash: hashToken(token),
    roleIds: ["tenant-admin", "tenant-viewer"],
    expiresAt,
    lastSentAt: new Date(),
    createdBy: "33333333-3333-4333-8333-333333333333",
    createdAt: new Date(),
    tenant: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "acme",
      displayName: "Acme Corp",
    },
  };
  const prisma = {
    tenantInvitation: {
      findUnique: vi.fn().mockResolvedValue(invitation),
    },
    role: {
      findMany: vi.fn().mockResolvedValue([
        { id: "tenant-viewer", name: "Tenant viewer" },
        { id: "tenant-admin", name: "Tenant admin" },
      ]),
    },
  };
  return { token, prisma, service: new TenantsService(prisma as never) };
}

describe("tenant invitation links", () => {
  it("returns a public preview without exposing the invited email or token hash", async () => {
    const { token, prisma, service } = fixture();
    const preview = await service.getInvitationPreview(token);

    expect(prisma.tenantInvitation.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(token) },
      include: {
        tenant: { select: { id: true, name: true, displayName: true } },
      },
    });
    expect(preview).toEqual({
      tenant: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "acme",
        displayName: "Acme Corp",
      },
      roles: [
        { id: "tenant-admin", name: "Tenant admin" },
        { id: "tenant-viewer", name: "Tenant viewer" },
      ],
      expiresAt: preview.expiresAt,
      status: "Pending",
    });
    expect(preview.expiresAt).toBeInstanceOf(Date);
    expect(JSON.stringify(preview)).not.toContain("alice@example.com");
    expect(JSON.stringify(preview)).not.toContain(hashToken(token));
  });

  it("marks an expired invitation instead of allowing the UI to treat it as pending", async () => {
    const { token, service } = fixture(new Date(Date.now() - 60_000));
    await expect(service.getInvitationPreview(token)).resolves.toMatchObject({ status: "Expired" });
  });

  it("does not disclose whether short malformed invitation tokens exist", async () => {
    const { service, prisma } = fixture();
    await expect(service.getInvitationPreview("short")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tenantInvitation.findUnique).not.toHaveBeenCalled();
  });
});
