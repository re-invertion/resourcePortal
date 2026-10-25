import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {createHash} from "node:crypto";
import {managedBridgeName} from "./remote-lan-managed-uplink";
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
  it("requires fresh authenticated LAN observation before granting managed Static",async()=>{
    const {p,service}=fixture();
    p.resourcePortalGate.findFirst.mockResolvedValue({
      id:gateId,agentVersion:"gate-l2-v2",observedLanAt:new Date(),
      observedLan:{protocol:1,gateId,segmentId:createHash("sha256").update(gateId+":eth0:192.168.50.0/24").digest("hex").slice(0,24),
        physicalInterface:"eth0",bridge:managedBridgeName(gateId,"eth0"),
        networkCidr:"192.168.50.0/24",gateway:"192.168.50.1",
        state:"Ready",observedAt:new Date().toISOString(),agentVersion:"gate-l2-v2"}
    });
    const record=await service.create(tenantId,{...input,uplinkMode:"ManagedSharedUplink",
      addressMode:"Static",staticAddress:"192.168.50.25/24",staticGateway:"192.168.50.1"},actor);
    expect(record).toMatchObject({status:"Pending",addressMode:"Static",
      staticAddress:"192.168.50.25/24",staticGateway:"192.168.50.1"});
    await expect(service.create(tenantId,{...input,uplinkMode:"ManagedSharedUplink",
      addressMode:"Static",staticAddress:"192.168.50.25/24",staticGateway:"192.168.51.99"},actor))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(tenantId,{...input,uplinkMode:"ManagedSharedUplink",
      lanCidr:"192.168.51.0/24"},actor)).rejects.toBeInstanceOf(BadRequestException);
    p.resourcePortalGate.findFirst.mockResolvedValue({id:gateId,agentVersion:"gate-l2-v2",
      observedLanAt:new Date(Date.now()-120000)});
    await expect(service.create(tenantId,{...input,uplinkMode:"ManagedSharedUplink"},actor))
      .rejects.toBeInstanceOf(BadRequestException);
  });
  it("transitions managed addressing through a new Pending revision and retains audit",async()=>{
    const {p,service}=fixture();
    p.remoteLanAttachment.findFirst.mockResolvedValue({
      id:"aaaaaaaa-bbbb-4ccc-8ddd-111111111111",tenantId,
      singleAppId,gateId,lanInterface:"eth0",lanCidr:input.lanCidr,
      uplinkMode:"ManagedSharedUplink",addressMode:"Static",
      staticAddress:"192.168.50.25/24",staticGateway:"192.168.50.1",
      status:"Active",gate:{agentVersion:"gate-l2-v2"}
    });
    const result=await service.updateAddressing(tenantId,
      "aaaaaaaa-bbbb-4ccc-8ddd-111111111111",{addressMode:"DHCP"},actor);
    expect(result).toMatchObject({addressMode:"DHCP",status:"Pending"});
    expect(p.remoteLanAttachment.update).toHaveBeenCalledWith({
      where:{id:"aaaaaaaa-bbbb-4ccc-8ddd-111111111111"},
      data:{addressMode:"DHCP",staticAddress:null,staticGateway:null,
        configurationRevision:{increment:1},status:"Pending",
        dhcpAddress:null,leaseExpiresAt:null,lastVerifiedAt:null,lastError:null}
    });
    expect(p.auditLogEntry.create).toHaveBeenCalled();
  });
  it("lists only tenant-owned attachments", async () => {
    const {p,service} = fixture();
    await service.list(tenantId);
    expect(p.remoteLanAttachment.findMany).toHaveBeenCalledWith({
      where: {tenantId}, orderBy: {createdAt:"asc"},
    });
  });
});
