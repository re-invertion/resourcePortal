import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/types";
import type { PrismaService } from "../prisma/prisma.service";
import { RemoteLanAttachmentService } from "./remote-lan-attachment.service";

const tenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const gateId = "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb";
const singleAppId = "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa";
const actor = { id: "aaaaaaaa-bbbb-4ccc-8ddd-cccccccccccc" } as AuthenticatedUser;
const networkId = "aaaaaaaa-bbbb-4ccc-8ddd-121212121212";
const input = { gateId, singleAppId, networkId, lanCidr: "192.168.50.0/24", lanInterface: "eth0" };

function fixture() {
  const p = {
    remoteLanAttachment: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({data}: {data: Record<string,unknown>}) => Promise.resolve(data)),
      update: vi.fn().mockImplementation(({data}: {data: Record<string,unknown>}) => Promise.resolve(data)),
    },
    resourcePortalGate: {
      findFirst: vi.fn().mockResolvedValue({id: gateId, lanCidrs: ["192.168.50.0/24"], agentVersion: "gate-shell-v3"}),
    },
    singleApp: { findFirst: vi.fn().mockResolvedValue({ id: singleAppId, desiredReplicas: 1 }) },
    networkAttachment: { findFirst: vi.fn().mockResolvedValue({ id: networkId }) },
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: "Tenant" }) },
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(p)),
  };
  return { p, service: new RemoteLanAttachmentService(p as unknown as PrismaService) };
}

describe("remote LAN control-plane desired state", () => {
  it("creates only a Pending request, never an unproven Active attachment", async () => {
    const {p, service} = fixture();
    const record = await service.create(tenantId, input, actor);
    expect(record.status).toBe("Pending");
    expect(record.dhcpAddress).toBeUndefined();
    expect(parseInt(record.macAddress.split(":")[0], 16) & 3).toBe(2);
    expect(p.resourcePortalGate.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: gateId, tenantId, revokedAt: null },
    }));
    expect(p.singleApp.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: singleAppId, pendingDeletion: false, appGroup: { tenantId } },
    }));
  });
  it("rejects a foreign Gate, missing app or existing app attachment", async () => {
    const {p,service} = fixture();
    p.resourcePortalGate.findFirst.mockResolvedValue(null);
    await expect(service.create(tenantId,input,actor)).rejects.toBeInstanceOf(NotFoundException);
    p.resourcePortalGate.findFirst.mockResolvedValue({id:gateId,lanCidrs:[input.lanCidr]});
    p.remoteLanAttachment.findUnique.mockResolvedValue({id:"already"});
    await expect(service.create(tenantId,input,actor)).rejects.toBeInstanceOf(ConflictException);
  });
  it("rejects invalid Gate subnet, bridge interface and replicated apps", async () => {
    const {p,service} = fixture();
    await expect(service.create(tenantId,{...input,lanInterface:"rp-gate"},actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(tenantId,{...input,lanCidr:"not-a-cidr"},actor)).rejects.toBeInstanceOf(BadRequestException);
    p.singleApp.findFirst.mockResolvedValue({id:singleAppId,desiredReplicas:2});
    await expect(service.create(tenantId,input,actor)).rejects.toBeInstanceOf(BadRequestException);
  });
  it("permits explicit DHCP subnet on an unnumbered dedicated Gate handoff",async () => {
    const {p,service}=fixture();
    p.resourcePortalGate.findFirst.mockResolvedValue({
      id:gateId,lanCidrs:[],agentVersion:"gate-l2-v1",
    });
    const created=await service.create(tenantId,{...input,lanCidr:"192.168.73.0/24",lanInterface:"eth2"},actor);
    expect(created).toMatchObject({lanCidr:"192.168.73.0/24",lanInterface:"eth2",status:"Pending"});
    expect(created).not.toHaveProperty("dhcpAddress");
  });
  it("revokes and removes lease metadata but retains cleanup tombstone", async () => {
    const {p,service} = fixture();
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-dddddddddddd";
    p.remoteLanAttachment.findFirst.mockResolvedValue({id,tenantId,status:"Pending"});
    await service.revoke(tenantId,id,actor);
    expect(p.remoteLanAttachment.findFirst).toHaveBeenCalledWith({ where: {id,tenantId} });
    expect(p.remoteLanAttachment.update).toHaveBeenCalledWith({
      where: {id}, data: {status:"Revoking",dhcpAddress:null,leaseExpiresAt:null},
    });
  });
  it("lists only tenant-owned attachments", async () => {
    const {p,service} = fixture();
    await service.list(tenantId);
    expect(p.remoteLanAttachment.findMany).toHaveBeenCalledWith({
      where: {tenantId}, orderBy: {createdAt:"asc"},
    });
  });
});
