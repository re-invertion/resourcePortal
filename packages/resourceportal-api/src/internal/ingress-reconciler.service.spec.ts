import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { IngressReconcilerService } from "./ingress-reconciler.service";
import { StackRuntimeService } from "./stack-runtime.service";

type ReconcileInput = {
  serviceName: string;
  desiredLabels: Record<string, string>;
};

function singleNetworkArtifact(appGroupId: string) {
  const networkName = `rp-appgroup-${appGroupId}`;
  return `services:\n  web_app:\n    networks: [default]\n    deploy:\n      labels:\n        traefik.enable: "true"\n        traefik.swarm.network: ${networkName}\nnetworks:\n  default:\n    external: true\n    name: ${networkName}\n`;
}

function legacyArtifact(appGroupId: string) {
  const networkName = `rp-appgroup-${appGroupId}`;
  const legacy = `rp-ingress-${appGroupId}`;
  return `services:\n  web_app:\n    networks: [default, ingress]\n    deploy:\n      labels:\n        traefik.enable: "true"\n        traefik.swarm.network: ${legacy}\nnetworks:\n  default:\n    name: ${networkName}\n    driver: overlay\n  ingress:\n    external: true\n    name: ${legacy}\n`;
}

function deployedAppGroup(
  id = "11111111-1111-4111-8111-111111111111",
  topology: "single" | "legacy" = "single",
) {
  return {
    id,
    currentDeploymentVersion: 3,
    deployments: [
      {
        version: 3,
        renderedStack:
          topology === "single"
            ? singleNetworkArtifact(id)
            : legacyArtifact(id),
      },
    ],
    singleApps: [
      {
        name: "web-app",
        pendingDeletion: false,
        httpEndpoints: [
          {
            name: "public",
            containerPort: 8080,
            protocolMode: "HTTP_REDIRECT_TO_HTTPS",
            domains: [{ hostname: "app.example.com" }],
          },
        ],
      },
    ],
  };
}

function serviceFor(appGroups: object[]) {
  const prisma = {
    appGroup: { findMany: vi.fn().mockResolvedValue(appGroups) },
  };
  const runtime = {
    reconcileAppGroupNetwork: vi.fn().mockResolvedValue({
      success: true,
      changed: false,
    }),
    reconcileLegacyIngressNetwork: vi.fn().mockResolvedValue({
      success: true,
      changed: false,
    }),
    reconcileServiceNetwork: vi.fn().mockResolvedValue({
      success: true,
      changed: false,
    }),
    reconcileTraefikLabels: vi.fn((input: ReconcileInput) => {
      void input;
      return Promise.resolve({ changed: true, success: true });
    }),
  };
  return {
    runtime,
    service: new IngressReconcilerService(
      prisma as unknown as PrismaService,
      runtime as unknown as StackRuntimeService,
    ),
  };
}

describe("IngressReconcilerService v0.2 single App Group network", () => {
  it("can scope reconciliation to one App Group without changing the global default", async () => {
    const appGroup = deployedAppGroup();
    const prisma = {
      appGroup: { findMany: vi.fn().mockResolvedValue([appGroup]) },
    };
    const runtime = {
      reconcileAppGroupNetwork: vi.fn().mockResolvedValue({
        success: true,
        changed: false,
      }),
      reconcileLegacyIngressNetwork: vi.fn().mockResolvedValue({
        success: true,
        changed: false,
      }),
      reconcileServiceNetwork: vi.fn().mockResolvedValue({
        success: true,
        changed: false,
      }),
      reconcileTraefikLabels: vi.fn().mockResolvedValue({
        success: true,
        changed: false,
      }),
    };
    const service = new IngressReconcilerService(
      prisma as unknown as PrismaService,
      runtime as unknown as StackRuntimeService,
    );

    await service.reconcileBatch({ appGroupId: appGroup.id });

    expect(prisma.appGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          currentDeploymentVersion: { not: null },
          id: appGroup.id,
        },
      }),
    );
  });

  it("keeps every tenant service on rp-appgroup and joins Traefik only for public groups", async () => {
    const appGroup = deployedAppGroup();
    const { runtime, service } = serviceFor([appGroup]);

    const result = await service.reconcileBatch();
    const networkName = `rp-appgroup-${appGroup.id}`;
    const legacyNetworkName = `rp-ingress-${appGroup.id}`;

    expect(runtime.reconcileAppGroupNetwork).toHaveBeenCalledWith({
      networkName,
      traefikRequired: true,
    });
    expect(runtime.reconcileServiceNetwork).toHaveBeenNthCalledWith(1, {
      serviceName: "rp_11111111_1111_4111_8111_111111111111_web_app",
      networkName,
      required: true,
    });
    expect(runtime.reconcileServiceNetwork).toHaveBeenNthCalledWith(2, {
      serviceName: "rp_11111111_1111_4111_8111_111111111111_web_app",
      networkName: legacyNetworkName,
      required: false,
    });
    expect(runtime.reconcileTraefikLabels.mock.calls[0]?.[0]).toMatchObject({
      serviceName: "rp_11111111_1111_4111_8111_111111111111_web_app",
      desiredLabels: {
        "traefik.swarm.network": networkName,
        "traefik.http.routers.web-app-public-http.rule":
          "Host(`app.example.com`)",
      },
    });
    expect(runtime.reconcileLegacyIngressNetwork).toHaveBeenLastCalledWith({
      networkName: legacyNetworkName,
      required: false,
    });
    expect(result).toEqual({ checked: 1, changed: 1, failed: 0 });
  });

  it("keeps the shared App Group overlay for a private group but removes Traefik routing and legacy ingress", async () => {
    const appGroup = deployedAppGroup();
    appGroup.singleApps[0].httpEndpoints[0].domains = [];
    const { runtime, service } = serviceFor([appGroup]);

    await service.reconcileBatch();

    const networkName = `rp-appgroup-${appGroup.id}`;
    const legacyNetworkName = `rp-ingress-${appGroup.id}`;
    expect(runtime.reconcileAppGroupNetwork).toHaveBeenCalledWith({
      networkName,
      traefikRequired: false,
    });
    expect(runtime.reconcileServiceNetwork).toHaveBeenNthCalledWith(1, {
      serviceName: "rp_11111111_1111_4111_8111_111111111111_web_app",
      networkName,
      required: true,
    });
    expect(runtime.reconcileTraefikLabels).toHaveBeenCalledWith({
      serviceName: "rp_11111111_1111_4111_8111_111111111111_web_app",
      desiredLabels: {},
    });
    expect(runtime.reconcileLegacyIngressNetwork).toHaveBeenCalledWith({
      networkName: legacyNetworkName,
      required: false,
    });
  });

  it("keeps private siblings on the same App Group network without publishing them through Traefik", async () => {
    const appGroup = deployedAppGroup();
    appGroup.singleApps.push({
      name: "internal-api",
      pendingDeletion: false,
      httpEndpoints: [],
    });
    const { runtime, service } = serviceFor([appGroup]);

    await service.reconcileBatch();

    const networkName = `rp-appgroup-${appGroup.id}`;
    expect(runtime.reconcileServiceNetwork).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        serviceName: "rp_11111111_1111_4111_8111_111111111111_internal_api",
        networkName,
        required: true,
      }),
    );
    expect(runtime.reconcileTraefikLabels).toHaveBeenNthCalledWith(2, {
      serviceName: "rp_11111111_1111_4111_8111_111111111111_internal_api",
      desiredLabels: {},
    });
    expect(runtime.reconcileAppGroupNetwork).toHaveBeenCalledTimes(1);
  });

  it("preserves the legacy two-network topology while a v0.1.x artifact remains current", async () => {
    const appGroup = deployedAppGroup(undefined, "legacy");
    const { runtime, service } = serviceFor([appGroup]);

    await service.reconcileBatch();

    const legacyNetworkName = `rp-ingress-${appGroup.id}`;
    expect(runtime.reconcileAppGroupNetwork).not.toHaveBeenCalled();
    expect(runtime.reconcileLegacyIngressNetwork).toHaveBeenCalledWith({
      networkName: legacyNetworkName,
      required: true,
    });
    expect(runtime.reconcileServiceNetwork).toHaveBeenCalledWith({
      serviceName: "rp_11111111_1111_4111_8111_111111111111_web_app",
      networkName: legacyNetworkName,
      required: true,
    });
    expect(runtime.reconcileTraefikLabels.mock.calls[0]?.[0]).toMatchObject({
      desiredLabels: { "traefik.swarm.network": legacyNetworkName },
    });
  });

  it("reports runtime reconciliation failure without stopping the batch", async () => {
    const first = deployedAppGroup();
    const second = deployedAppGroup("22222222-2222-4222-8222-222222222222");
    const { runtime, service } = serviceFor([first, second]);
    runtime.reconcileTraefikLabels
      .mockResolvedValueOnce({ changed: false, success: false })
      .mockResolvedValueOnce({ changed: true, success: true });

    const result = await service.reconcileBatch();

    expect(runtime.reconcileTraefikLabels).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ checked: 2, changed: 1, failed: 1 });
  });
});
