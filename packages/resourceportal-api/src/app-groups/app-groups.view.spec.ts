import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { mapAppGroupDeployment, mapSingleApp } from "./app-groups.view";

describe("mapAppGroupDeployment", () => {
  it("parses stackConfig JSON without altering deployment fields", () => {
    const deployment = {
      id: "deployment-id",
      appGroupId: "app-group-id",
      version: 7,
      status: DeploymentStatus.Pending,
      phase: DeploymentPhase.Validating,
      stackConfig: JSON.stringify({
        singleApps: [
          {
            id: "app-id",
            secrets: [{ id: "secret-id", valueVersion: 2 }],
          },
        ],
      }),
      renderedStack: null,
      renderedAt: null,
      sourceDraftRevision: 12,
      rollbackTargetVersion: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      correlationId: "correlation-id",
      idempotencyKey: null,
      errorCode: null,
      errorMessage: null,
      createdBy: "user-id",
      createdAt: new Date("2026-08-27T00:00:00.000Z"),
      startedAt: null,
      completedAt: null,
    };

    expect(mapAppGroupDeployment(deployment).stackConfig).toEqual({
      singleApps: [
        {
          id: "app-id",
          secrets: [{ id: "secret-id", valueVersion: 2 }],
        },
      ],
    });
  });
});

describe("mapSingleApp", () => {
  const baseApp = {
    id: "app-id",
    appGroupId: "group-id",
    name: "web",
    description: null,
    image: "ghcr.io/example/web:1",
    cpu: { toString: () => "0.5" },
    memoryBytes: { toString: () => "536870912" },
    gpu: 0,
    desiredReplicas: 1,
    runtimeState: "Running",
    health: "Healthy",
    restartPolicy: "UnlessStopped",
    pendingDeletion: false,
    createdAt: new Date("2026-09-28T00:00:00.000Z"),
    updatedAt: new Date("2026-09-28T00:00:00.000Z"),
  };

  it("exposes a Web UI URL from an assigned domain without leaking endpoint relations", () => {
    const mapped = mapSingleApp({
      ...baseApp,
      httpEndpoints: [{
        id: "endpoint-id",
        singleAppId: "app-id",
        name: "web",
        containerPort: 3000,
        protocol: "HTTP",
        createdAt: new Date("2026-09-28T00:00:00.000Z"),
        updatedAt: new Date("2026-09-28T00:00:00.000Z"),
        domains: [{
          id: "domain-id",
          tenantId: "tenant-id",
          hostname: "app.example.test",
          type: "Custom",
          prefix: null,
          subdomain: null,
          customRootDomainId: null,
          dnsStatus: "Valid",
          verificationToken: null,
          verifiedAt: null,
          tlsEnabled: true,
          certificateStatus: "Active",
          certificateIssuer: null,
          certificateExpiresAt: null,
          certificateLastError: null,
          httpEndpointId: "endpoint-id",
          createdAt: new Date("2026-09-28T00:00:00.000Z"),
          updatedAt: new Date("2026-09-28T00:00:00.000Z"),
        }],
      }],
    } as never);

    expect(mapped.webUiUrl).toBe("https://app.example.test");
    expect(mapped).not.toHaveProperty("httpEndpoints");
  });

  it("omits the Web UI URL when no HTTP domain is assigned", () => {
    const mapped = mapSingleApp({ ...baseApp, httpEndpoints: [] } as never);
    expect(mapped.webUiUrl).toBeUndefined();
  });
});
