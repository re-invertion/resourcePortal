/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method */
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { StackRuntimeService } from "../internal/stack-runtime.service";
import type { StackSecretProvisionerService } from "../internal/stack-secret-provisioner.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import { GateRuntimeReconcilerService } from "./gate-runtime-reconciler.service";

class TestGateRuntimeReconcilerService extends GateRuntimeReconcilerService {
  readonly dockerCalls: Array<{ args: string[]; stdin?: string }> = [];
  readonly dockerResults: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  readonly capabilityResults: string[] = [];
  sysctlValue: string | null = null;
  applySysctlUpdate = true;

  protected override runDocker(args: string[], stdin?: string) {
    this.dockerCalls.push({ args, stdin });
    // The test's fake Swarm implements the effective capability inspection.
    if (args[0] === "service" && args[1] === "inspect" &&
        args.at(-1)?.includes("CapabilityAdd")) {
      return Promise.resolve({ exitCode: 0, stdout: this.capabilityResults.shift() ?? '["CAP_NET_ADMIN","CAP_NET_RAW"]', stderr: "" });
    }
    if (args[0] === "service" && args[1] === "inspect" &&
        args.at(-1)?.includes("Sysctls"))
      return Promise.resolve({exitCode:0,stdout:JSON.stringify(this.sysctlValue === null ? null :
        {"net.ipv4.ip_forward":this.sysctlValue}),stderr:""});
    if (args[0] === "service" && args[1] === "update" &&
        args.includes("--sysctl-add")) {
      if (this.applySysctlUpdate) this.sysctlValue="0";
      return Promise.resolve({exitCode:0,stdout:"updated",stderr:""});
    }
    return Promise.resolve(
      this.dockerResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" },
    );
  }
}

function fixture(gates: any[], deletingNetworks: any[] = []) {
  const prisma = {
    resourcePortalGate: {
      findMany: vi.fn().mockResolvedValue(gates),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    gateNetworkAttachment: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    network: {
      findMany: vi.fn().mockImplementation(({where}: any) => Promise.resolve(where.status === "Deleting" ? deletingNetworks : [])),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(async (queries: Promise<unknown>[]) =>
      Promise.all(queries),
    ),
  } as unknown as PrismaService;
  const config = {
    get: vi.fn((key: string, fallback?: unknown) =>
      key === "RESOURCEPORTAL_RUNTIME_IMAGE"
        ? "ghcr.io/re-invertion/resourceportal-api:test"
        : fallback,
    ),
  } as unknown as ConfigService;
  const encryption = {
    decrypt: vi.fn().mockReturnValue("server-private-key"),
  } as unknown as EncryptionService;
  const runtime = {
    reconcileTenantNetwork: vi
      .fn()
      .mockResolvedValue({ success: true, changed: false }),
    removeTenantNetwork: vi
      .fn()
      .mockResolvedValue({ success: true, changed: true }),
  } as unknown as StackRuntimeService;
  const secrets = {
    provisionSecrets: vi.fn().mockResolvedValue({
      success: true,
      message: "ok",
      details: "",
    }),
  } as unknown as StackSecretProvisionerService;
  return {
    prisma,
    encryption,
    runtime,
    secrets,
    service: new TestGateRuntimeReconcilerService(
      prisma,
      config,
      encryption,
      runtime,
      secrets,
    ),
  };
}

const readyGate = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  status: "Ready",
  publicKey: "client-public-key",
  serverPrivateKeyCiphertext: "enc:v1:cipher",
  serverKeyVersion: 2,
  serverListenPort: 52001,
  serverTunnelAddress: "10.253.0.1/30",
  clientTunnelAddress: "10.253.0.2/30",
  revokedAt: null,
  lanCidrs: ["192.168.50.0/24"],
  networks: [
    {
      enabled: true,
      network: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        swarmNetworkName:
          "rp-network-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        overlayCidr: "10.200.5.0/24",
        attachments: [
          {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            address: "10.240.5.10",
          },
        ],
      },
    },
  ],
};

describe("Gate capability reconciliation", () => {
  it("repairs missing effective capabilities and verifies the updated Swarm spec", async () => {
    const { service } = fixture([]);
    service.capabilityResults.push('["NET_ADMIN"]', '["NET_ADMIN","NET_RAW"]');
    const invoke = service as unknown as { ensureGatewayCapabilities(id: string): Promise<void> };
    await expect(invoke.ensureGatewayCapabilities(readyGate.id)).resolves.toBeUndefined();
    expect(service.dockerCalls).toContainEqual({
      args: ["service", "update", "--detach=false", "--cap-add", "NET_RAW",
        "rp_gate_aaaaaaaa_aaaa_4aaa_8aaa_aaaaaaaaaaaa_gateway"],
      stdin: undefined,
    });
  });
  it("treats canonical CAP_ names as already granted without a service restart", async () => {
    const { service } = fixture([]);
    service.capabilityResults.push('["CAP_NET_ADMIN","CAP_NET_RAW"]');
    const invoke = service as unknown as { ensureGatewayCapabilities(id: string): Promise<void> };
    await expect(invoke.ensureGatewayCapabilities(readyGate.id)).resolves.toBeUndefined();
    expect(service.dockerCalls.filter(x => x.args[0] === "service" && x.args[1] === "update")).toHaveLength(0);
  });
  it("checks canonical CAP_ names after an update and rejects malformed inspect data", async () => {
    const { service } = fixture([]);
    service.capabilityResults.push('["CAP_NET_ADMIN"]', '["CAP_NET_ADMIN","CAP_NET_RAW"]');
    const invoke = service as unknown as { ensureGatewayCapabilities(id: string): Promise<void> };
    await expect(invoke.ensureGatewayCapabilities(readyGate.id)).resolves.toBeUndefined();
    expect(service.dockerCalls.some(x => x.args.includes("--cap-add"))).toBe(true);
    const malformed = fixture([]);
    malformed.service.capabilityResults.push('{"CAP_NET_ADMIN":true}');
    const another = malformed.service as unknown as { ensureGatewayCapabilities(id: string): Promise<void> };
    await expect(another.ensureGatewayCapabilities(readyGate.id)).rejects.toThrow("Malformed");
  });
  it("fails closed if the capability never appears in the active Swarm spec", async () => {
    const { service } = fixture([]);
    service.capabilityResults.push('["NET_ADMIN"]', '["NET_ADMIN"]');
    const invoke = service as unknown as { ensureGatewayCapabilities(id: string): Promise<void> };
    await expect(invoke.ensureGatewayCapabilities(readyGate.id)).rejects.toThrow("not applied");
  });
});

describe("Gate task network-namespace forwarding contract", () => {
  const name="rp_gate_aaaaaaaa_aaaa_4aaa_8aaa_aaaaaaaaaaaa_gateway";
  const call=(service:TestGateRuntimeReconcilerService)=>
    (service as unknown as {
      ensureGatewayCapabilities(id:string,enforceForwarding:boolean): Promise<void>;
    }).ensureGatewayCapabilities(readyGate.id,true);

  it("provisions the Swarm namespace sysctl without writing the host /proc/sys", async () => {
    const {service}=fixture([]);
    await call(service);
    const updates=service.dockerCalls.filter(x=>x.args[0]==="service"&&x.args[1]==="update");
    expect(updates.map(x=>x.args)).toEqual([[
      "service","update","--detach=false","--sysctl-add","net.ipv4.ip_forward=0",name,
    ]]);
    expect(service.sysctlValue).toBe("0");
    await call(service);
    expect(service.dockerCalls.filter(x=>x.args[0]==="service"&&x.args[1]==="update"))
      .toHaveLength(1);
  });
  it("atomically applies missing caps and forwarding to avoid restart-loop deadlock", async () => {
    const {service}=fixture([]);
    service.capabilityResults.push('["NET_ADMIN"]','["NET_ADMIN","NET_RAW"]');
    await call(service);
    const updates=service.dockerCalls.filter(x=>x.args[1]==="update");
    expect(updates).toHaveLength(1);
    expect(updates[0].args).toEqual([
      "service","update","--detach=false",
      "--cap-add","NET_RAW","--sysctl-add","net.ipv4.ip_forward=0",name,
    ]);
  });
  it("fails closed if Docker refuses to persist namespace isolation", async () => {
    const {service}=fixture([]);
    service.applySysctlUpdate=false;
    await expect(call(service)).rejects.toThrow("not applied");
    expect(service.dockerCalls.some(x=>x.args.includes("--sysctl-add"))).toBe(true);
  });
  it("blocks the actual Gate reconcile before Ready when isolation is absent", async () => {
    const gate={...readyGate,agentVersion:"gate-l2-v1",remoteLanAttachments: [{
      id:"ffffffff-ffff-4fff-8fff-ffffffffffff",
      tenantId:readyGate.tenantId,gateId:readyGate.id,
      networkId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      singleAppId:"99999999-9999-4999-8999-999999999999",
      macAddress:"02:aa:bb:cc:dd:ee",
      singleApp:{name:"sensor",appGroupId:"88888888-8888-4888-8888-888888888888",
        desiredReplicas:1,pendingDeletion:false,appGroup:{tenantId:readyGate.tenantId}},
      network:{id:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        tenantId:readyGate.tenantId,swarmNetworkName:"rp-network-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        overlayCidr:"10.200.40.0/24"},
    }]};
    const {service,prisma}=fixture([gate]);
    service.applySysctlUpdate=false;
    await expect(service.reconcile()).resolves.toMatchObject({ready:0,failed:1});
    expect(prisma.resourcePortalGate.update).toHaveBeenCalledWith(expect.objectContaining({
      data:expect.objectContaining({status:"Error",lastError:expect.stringContaining("not applied")}),
    }));
    service.applySysctlUpdate=true;
    await expect(service.reconcile()).resolves.toMatchObject({ready:1,failed:0});
  });
});

describe("GateRuntimeReconcilerService", () => {
  it("attaches a Gate to a remote application's overlay without any Site VPN link", async () => {
    const networkId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const gate = {
      ...readyGate, networks: [], agentVersion:"gate-l2-v1",
      remoteLanAttachments: [{
        id:"ffffffff-ffff-4fff-8fff-ffffffffffff",
        tenantId:readyGate.tenantId,
        gateId:readyGate.id,
        singleAppId:"99999999-9999-4999-8999-999999999999",
        networkId,
        macAddress:"02:aa:bb:cc:dd:ee",
        singleApp:{name:"home-assistant",appGroupId:"88888888-8888-4888-8888-888888888888",desiredReplicas:1,pendingDeletion:false,appGroup:{tenantId:readyGate.tenantId}},
        network:{id:networkId,tenantId:readyGate.tenantId,swarmNetworkName:"rp-network-"+networkId,overlayCidr:"10.200.40.0/24"},
      }],
    };
    const {service,runtime}=fixture([gate]);
    await expect(service.reconcile()).resolves.toMatchObject({ready:1,failed:0});
    expect(runtime.reconcileTenantNetwork).toHaveBeenCalledWith({
      networkName:"rp-network-"+networkId,
      subnet:"10.200.40.0/24",
      networkId,
      tenantId:readyGate.tenantId,
    });
    const rendered=service.dockerCalls.find(x=>x.args[0]==="stack"&&x.args[1]==="deploy")?.stdin;
    expect(rendered).toContain("rp-network-"+networkId);
    const encoded=rendered?.match(/RP_GATE_CONFIG_B64:\s+(\S+)/)?.[1];
    expect(encoded).toBeTruthy();
    const runtimeConfig=JSON.parse(Buffer.from(encoded??"","base64").toString("utf8"));
    expect(runtimeConfig).not.toHaveProperty("mappings");
    expect(runtimeConfig.remoteLanAttachments).toEqual([expect.objectContaining({
      attachmentId:"ffffffff-ffff-4fff-8fff-ffffffffffff",
      tenantId:readyGate.tenantId,
      networkId,
      macAddress:"02:aa:bb:cc:dd:ee",
    })]);
  });

  it("revokes old hosted routed gateway services when no LAN Attachment is authorized", async () => {
    const { service, runtime, secrets } = fixture([{
      ...readyGate, agentVersion:"gate-l2-v1", remoteLanAttachments: [],
    }]);
    await expect(service.reconcile()).resolves.toMatchObject({ready:1,failed:0});
    expect(runtime.reconcileTenantNetwork).not.toHaveBeenCalled();
    expect(secrets.provisionSecrets).not.toHaveBeenCalled();
    expect(service.dockerCalls.map(call => call.args)).toContainEqual([
      "stack","rm","rp_gate_aaaaaaaa_aaaa_4aaa_8aaa_aaaaaaaaaaaa",
    ]);
  });

  it("removes the previous Gate stack until the physical Gate runs the certified L2 agent", async () => {
    const {service}=fixture([{...readyGate,agentVersion:"gate-shell-v3",remoteLanAttachments:[]}]);
    await expect(service.reconcile()).resolves.toMatchObject({ready:0,pending:1,failed:0});
    expect(service.dockerCalls.some(call=>call.args[0]==="stack"&&call.args[1]==="deploy")).toBe(false);
  });

  it("permanently deletes a Gate only after its runtime and private key are removed", async () => {
    const { service, prisma } = fixture([
      {
        ...readyGate,
        status: "Deleting",
        revokedAt: new Date(),
        networks: [],
      },
    ]);

    await expect(service.reconcile()).resolves.toMatchObject({
      removed: 1,
      failed: 0,
    });
    expect(service.dockerCalls.map((call) => call.args)).toEqual([
      ["stack", "rm", "rp_gate_aaaaaaaa_aaaa_4aaa_8aaa_aaaaaaaaaaaa"],
      [
        "secret",
        "rm",
        "rp-gate-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-private-key-v2",
      ],
    ]);
    expect((prisma.resourcePortalGate.delete as any)).toHaveBeenCalledWith({
      where: { id: readyGate.id },
    });
  });

  it("permanently deletes legacy Revoked Gate records after runtime cleanup", async () => {
    const { service, prisma } = fixture([
      {
        ...readyGate,
        status: "Revoked",
        revokedAt: new Date(),
        networks: [],
      },
    ]);

    await expect(service.reconcile()).resolves.toMatchObject({
      removed: 1,
      failed: 0,
    });
    expect((prisma.resourcePortalGate.delete as any)).toHaveBeenCalledWith({
      where: { id: readyGate.id },
    });
  });

  it("keeps the Gate record when its private key secret cannot be removed", async () => {
    const { service, prisma } = fixture([
      {
        ...readyGate,
        status: "Deleting",
        revokedAt: new Date(),
        networks: [],
      },
    ]);
    service.dockerResults.push(
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "secret is in use by service" },
    );

    await expect(service.reconcile()).resolves.toMatchObject({
      removed: 0,
      failed: 1,
    });
    expect((prisma.resourcePortalGate.delete as any)).not.toHaveBeenCalled();
    expect((prisma.resourcePortalGate.update as any)).toHaveBeenCalledWith({
      where: { id: readyGate.id },
      data: expect.objectContaining({
        status: "Error",
        lastError: expect.stringContaining("secret is in use"),
      }),
    });
  });
  it("deletes a Network record only after the managed Swarm overlay is removed", async () => {
    const deleting = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      swarmNetworkName: "rp-network-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      status: "Deleting",
    };
    const { service, runtime, prisma } = fixture([], [deleting]);

    await expect(service.reconcile()).resolves.toMatchObject({
      networksDeleting: 1,
      networksDeleted: 1,
      networkDeleteFailures: 0,
    });
    expect(runtime.removeTenantNetwork).toHaveBeenCalledWith(
      "rp-network-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    expect((prisma.network.delete as any)).toHaveBeenCalledWith({
      where: { id: deleting.id },
    });
  });

  it("keeps a Network in Deleting when Swarm still has active endpoints", async () => {
    const deleting = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      swarmNetworkName: "rp-network-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      status: "Deleting",
    };
    const { service, runtime, prisma } = fixture([], [deleting]);
    (runtime.removeTenantNetwork as any).mockResolvedValue({
      success: false,
      changed: false,
      error: "network has active endpoints",
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      networksDeleting: 1,
      networksDeleted: 0,
      networkDeleteFailures: 1,
    });
    expect((prisma.network.delete as any)).not.toHaveBeenCalled();
    expect((prisma.network.update as any)).toHaveBeenCalledWith({
      where: { id: deleting.id },
      data: expect.objectContaining({
        lastError: "network has active endpoints",
      }),
    });
  });

});
describe("Tenant Network provisioning without a Site VPN", () => {
  it("advances a standalone Network to Ready after a successful Swarm reconcile", async () => {
    const f = fixture([]);
    (f.prisma.network.findMany as any).mockImplementation(({ where }: any) => Promise.resolve(
      where.status === "Deleting" ? [] : [{ id: "n1", tenantId: "tenant", swarmNetworkName: "rp-network-n1", overlayCidr: "10.90.0.0/24" }],
    ));
    await f.service.reconcile();
    expect(f.runtime.reconcileTenantNetwork).toHaveBeenCalledWith({
      networkName: "rp-network-n1", subnet: "10.90.0.0/24", networkId: "n1", tenantId: "tenant",
    });
    expect(f.prisma.network.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "n1" }, data: expect.objectContaining({ status: "Ready", lastError: null }),
    }));
  });
});