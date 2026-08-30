import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";
import { DeploymentWorkerService } from "../internal/deployment-worker.service";
import { CreateSingleAppDto } from "./dto/create-single-app.dto";
import { UpdateSingleAppDto } from "./dto/update-single-app.dto";

const stackSnapshot = (gpu: number) => ({
  appGroup: {
    id: "00000000-0000-4000-8000-000000000001",
    tenantId: "00000000-0000-4000-8000-000000000002",
    name: "stage4",
    runtimeState: "Running",
    runtimeDraftRevision: 0,
  },
  singleApps: [
    {
      id: "00000000-0000-4000-8000-000000000003",
      name: "api",
      image: "nginx:1.27",
      registryId: null,
      desiredReplicas: 2,
      runtimeState: "Running",
      resources: {
        cpu: "1.5",
        memoryBytes: "536870912",
        gpu,
      },
      environment: {},
      variables: [],
      secrets: [],
      configs: [],
      healthCheck: null,
      entrypoint: null,
      command: [],
      workingDir: null,
      user: null,
      readOnlyRootFilesystem: false,
      stopGracePeriodSeconds: 30,
      restartPolicy: {},
      updatePolicy: {},
      httpEndpoints: [],
      volumes: [],
    },
  ],
});

const createWorker = () => {
  const prisma = {
    appGroup: {
      findUnique: vi.fn().mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000001",
        status: "Ready",
        tenant: {
          status: "Active",
          quota: {
            cpu: 128,
            memoryBytes: 137438953472n,
            gpu: 8,
            storageBytes: 1099511627776n,
            maxSingleApps: 100,
            maxVolumes: 100,
          },
        },
      }),
    },
    registry: { findMany: vi.fn().mockResolvedValue([]) },
    volume: { findMany: vi.fn().mockResolvedValue([]) },
  };

  return new DeploymentWorkerService(
    prisma as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
};

describe("Stage 4 SingleApp completion", () => {
  it("renders CPU and memory as Docker Swarm resource limits", () => {
    const worker = createWorker();
    const renderStack = (
      worker as unknown as { renderStack: (stackConfig: string) => string }
    ).renderStack.bind(worker);

    const rendered = renderStack(JSON.stringify(stackSnapshot(0)));

    expect(rendered).toMatch(/cpus:\s*["']?1\.5["']?/);
    expect(rendered).toMatch(/memory:\s*["']?536870912B["']?/);
    expect(rendered).not.toContain("reservations:");
  });

  it("rejects active GPU allocation in create and update DTOs", async () => {
    const createDto = Object.assign(new CreateSingleAppDto(), {
      name: "api",
      image: "nginx:1.27",
      cpu: 1,
      memoryBytes: 536870912,
      gpu: 1,
    });
    const updateDto = Object.assign(new UpdateSingleAppDto(), { gpu: 1 });

    const createErrors = await validate(createDto);
    const updateErrors = await validate(updateDto);
    const createGpuMessages = Object.values(
      createErrors.find((error) => error.property === "gpu")?.constraints ?? {},
    );
    const updateGpuMessages = Object.values(
      updateErrors.find((error) => error.property === "gpu")?.constraints ?? {},
    );

    expect(createGpuMessages).toContain("GpuNotAvailable");
    expect(updateGpuMessages).toContain("GpuNotAvailable");
  });

  it("rejects legacy GPU allocations during deployment validation", async () => {
    const worker = createWorker();
    const validateDeploymentSnapshot = (
      worker as unknown as {
        validateDeploymentSnapshot: (deployment: {
          appGroupId: string;
          stackConfig: string;
        }) => Promise<{ success: boolean; errorCode?: string }>;
      }
    ).validateDeploymentSnapshot.bind(worker);

    const result = await validateDeploymentSnapshot({
      appGroupId: "00000000-0000-4000-8000-000000000001",
      stackConfig: JSON.stringify(stackSnapshot(1)),
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("GpuNotAvailable");
  });
});
