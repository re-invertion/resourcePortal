import { DeploymentPhase, DeploymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { mapAppGroupDeployment } from "./app-groups.view";

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
