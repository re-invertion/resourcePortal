import { describe, expect, it } from "vitest";
import { AppGroupsService } from "./app-groups.service";

const GPU = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NODE = "abcdefghijklmnopqrstuvwxy";

describe("GPU deployment snapshot (#368)", () => {
  it("persists the verified Swarm node together with the dedicated GPU UUID", () => {
    const service = Object.create(AppGroupsService.prototype) as AppGroupsService;
    const build = service as unknown as {
      buildStackConfigSnapshot: (draft: Record<string, unknown>) => {
        singleApps: Array<{
          resources: {
            gpu: number;
            gpuUuid: string | null;
            gpuNodeId: string | null;
          };
        }>;
      };
    };

    const snapshot = build.buildStackConfigSnapshot({
      id: "00000000-0000-4000-8000-000000000001",
      tenantId: "00000000-0000-4000-8000-000000000002",
      name: "gpu-group",
      runtimeState: "Running",
      runtimeDraftRevision: 2,
      singleApps: [{
        id: "00000000-0000-4000-8000-000000000003",
        name: "gpu-app",
        image: "alpine:3.20",
        registryId: null,
        desiredReplicas: 1,
        pendingDeletion: false,
        runtimeState: "Running",
        cpu: { toString: () => "0.5" },
        memoryBytes: 268435456n,
        gpu: 1,
        gpuAllocation: {
          uuid: GPU,
          remoteLocation: { swarmNodeId: NODE },
        },
        environment: {},
        variableAttachments: [],
        secretAttachments: [],
        secrets: [],
        configAttachments: [],
        healthCheck: {},
        entrypoint: null,
        command: [],
        workingDir: null,
        user: null,
        readOnlyRootFilesystem: true,
        stopGracePeriodSeconds: 30,
        restartPolicy: {},
        updatePolicy: {},
        httpEndpoints: [],
        networkAttachments: [],
        volumeAttachments: [],
      }],
    });

    expect(snapshot.singleApps[0]?.resources).toMatchObject({
      gpu: 1,
      gpuUuid: GPU,
      gpuNodeId: NODE,
    });
  });
});
