import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { IngressReconcilerService } from "./ingress-reconciler.service";
import { StackRuntimeService } from "./stack-runtime.service";

type ReconcileInput = {
  serviceName: string;
  desiredLabels: Record<string, string>;
};

function deployedAppGroup() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    currentDeploymentVersion: 3,
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
    appGroup: {
      findMany: vi.fn().mockResolvedValue(appGroups),
    },
  };
  const reconcileTraefikLabels = vi.fn((_input: ReconcileInput) =>
    Promise.resolve({ changed: true, success: true }),
  );
  const runtime = { reconcileTraefikLabels };
  return {
    runtime,
    service: new IngressReconcilerService(
      prisma as unknown as PrismaService,
      runtime as unknown as StackRuntimeService,
    ),
  };
}

describe("IngressReconcilerService", () => {
  it("reconciles only deployed app groups using deterministic RP service names", async () => {
    const appGroup = deployedAppGroup();
    const { runtime, service } = serviceFor([appGroup]);

    const result = await service.reconcileBatch();
    const input = runtime.reconcileTraefikLabels.mock.calls[0]?.[0];

    expect(input?.serviceName).toBe(
      "rp_11111111_1111_4111_8111_111111111111_web_app",
    );
    expect(input?.desiredLabels).toMatchObject({
      "traefik.http.routers.web-app-public-http.rule":
        "Host(`app.example.com`)",
      "traefik.http.routers.web-app-public-https.tls": "true",
    });
    expect(result).toEqual({ checked: 1, changed: 1, failed: 0 });
  });

  it("removes all RP Traefik routes when an existing service has no desired endpoints", async () => {
    const appGroup = deployedAppGroup();
    appGroup.singleApps[0].httpEndpoints = [];
    const { runtime, service } = serviceFor([appGroup]);

    await service.reconcileBatch();

    expect(runtime.reconcileTraefikLabels.mock.calls[0]?.[0]).toEqual({
      serviceName: "rp_11111111_1111_4111_8111_111111111111_web_app",
      desiredLabels: {},
    });
  });

  it("continues after one service reconciliation failure", async () => {
    const first = deployedAppGroup();
    const second = {
      ...deployedAppGroup(),
      id: "22222222-2222-4222-8222-222222222222",
    };
    const { runtime, service } = serviceFor([first, second]);
    runtime.reconcileTraefikLabels
      .mockResolvedValueOnce({ changed: false, success: false })
      .mockResolvedValueOnce({ changed: true, success: true });

    const result = await service.reconcileBatch();

    expect(runtime.reconcileTraefikLabels).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ checked: 2, changed: 1, failed: 1 });
  });
});
