import { describe, expect, it, vi } from "vitest";
import { buildDiscardRestorePlan } from "./discard-restore";
import { deriveAppGroupDriftStatus } from "./runtime-drift";
import { mapAppGroup } from "./app-groups.view";
import { Stage3AppGroupsService } from "./stage3-app-groups.service";

describe("Stage 3 AppGroup completion", () => {
  it("derives tenant, billing and platform-maintenance runtime blockers", () => {
    const mapped = mapAppGroup(
      {
        id: "app-group-id",
        status: "Ready",
        runtimeState: "Running",
        currentDeploymentVersion: 1,
        tenant: {
          status: "Suspended",
          billing: {
            balance: {
              lte: (value: number) => value === 0,
            },
          },
        },
      } as never,
      { platformMaintenance: true },
    );

    expect(mapped.effectiveRuntimeState).toBe("Stopped");
    expect(mapped.runtimeBlockers).toEqual(
      expect.arrayContaining([
        "TenantSuspended",
        "BillingSuspended",
        "PlatformMaintenance",
      ]),
    );
  });

  it("loads HTTP endpoint domains for Stage3 list and detail views so webUiUrl survives mapping", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const findFirst = vi.fn().mockResolvedValue({
      id: "app-group-id",
      tenantId: "tenant-id",
      name: "group",
      description: null,
      status: "Ready",
      runtimeState: "Stopped",
      currentDeploymentVersion: null,
      tenant: {
        status: "Active",
        billing: { balance: { lte: () => false } },
      },
      singleApps: [],
      deployments: [],
    });
    const prisma = {
      appGroup: { findMany, findFirst },
    };
    const config = {
      get: vi.fn().mockReturnValue(undefined),
    };
    const service = new Stage3AppGroupsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      config as never,
    );

    await service.listAppGroups("tenant-id");
    await service.getAppGroup("tenant-id", "app-group-id");

    const expectedSingleApps: unknown = expect.objectContaining({
      orderBy: { createdAt: "asc" },
      include: {
        httpEndpoints: {
          include: { domains: true },
        },
      },
    });
    const expectedInclude: unknown = expect.objectContaining({
      singleApps: expectedSingleApps,
    });
    const expectedQuery: unknown = expect.objectContaining({
      include: expectedInclude,
    });

    expect(findMany).toHaveBeenCalledWith(expectedQuery);
    expect(findFirst).toHaveBeenCalledWith(expectedQuery);
  });

  it("marks matching runtime state as InSync", () => {
    expect(
      deriveAppGroupDriftStatus(
        [
          {
            name: "rp_group_api",
            image: "ghcr.io/example/api:1",
            desiredReplicas: 2,
          },
        ],
        [
          {
            name: "rp_group_api",
            image: "ghcr.io/example/api:1",
            desiredReplicas: 2,
          },
        ],
      ),
    ).toBe("InSync");
  });

  it("marks externally changed runtime state as Drifted and unreadable state as Unknown", () => {
    const expected = [
      {
        name: "rp_group_api",
        image: "ghcr.io/example/api:1",
        desiredReplicas: 2,
      },
    ];

    expect(
      deriveAppGroupDriftStatus(expected, [
        {
          name: "rp_group_api",
          image: "ghcr.io/example/api:2",
          desiredReplicas: 2,
        },
      ]),
    ).toBe("Drifted");
    expect(deriveAppGroupDriftStatus(expected, null)).toBe("Unknown");
  });

  it("builds a complete discard plan for runtime-affecting attachments", () => {
    const plan = buildDiscardRestorePlan({
      appGroup: { runtimeState: "Running" },
      singleApps: [
        {
          id: "app-id",
          variables: [
            {
              id: "variable-attachment-id",
              variableId: "variable-id",
              variableName: "LOG_LEVEL",
              targetName: "LOG_LEVEL",
              value: "info",
            },
          ],
          configs: [
            {
              id: "config-attachment-id",
              configId: "config-id",
              configName: "nginx.conf",
              contentVersion: 3,
              targetPath: "/etc/nginx/nginx.conf",
              content: "events {}",
            },
          ],
          volumes: [
            {
              id: "volume-attachment-id",
              volumeId: "volume-id",
              mountPath: "/data",
              mode: "ReadWrite",
            },
          ],
          httpEndpoints: [
            {
              id: "endpoint-id",
              name: "web",
              containerPort: 8080,
              protocolMode: "HTTP_REDIRECT_TO_HTTPS",
              domains: [{ id: "domain-id" }],
            },
          ],
        },
      ],
    });

    expect(plan.variables).toEqual([
      { id: "variable-id", name: "LOG_LEVEL", value: "info" },
    ]);
    expect(plan.variableAttachments).toEqual([
      {
        id: "variable-attachment-id",
        variableId: "variable-id",
        singleAppId: "app-id",
        targetName: "LOG_LEVEL",
      },
    ]);
    expect(plan.configs).toEqual([
      {
        id: "config-id",
        name: "nginx.conf",
        content: "events {}",
        contentVersion: 3,
      },
    ]);
    expect(plan.configAttachments).toHaveLength(1);
    expect(plan.volumeAttachments).toHaveLength(1);
    expect(plan.httpEndpoints).toEqual([
      {
        id: "endpoint-id",
        singleAppId: "app-id",
        name: "web",
        containerPort: 8080,
        protocolMode: "HTTP_REDIRECT_TO_HTTPS",
      },
    ]);
    expect(plan.domainAssignments).toEqual([
      { domainId: "domain-id", httpEndpointId: "endpoint-id" },
    ]);
  });
});
