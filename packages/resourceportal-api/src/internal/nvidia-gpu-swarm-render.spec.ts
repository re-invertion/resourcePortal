import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DeploymentExecutionService } from "./deployment-execution.service";

const GPU = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NODE = "abcdefghijklmnopqrstuvwxy";

function snapshot(
  gpu: number,
  gpuUuid: string | null = null,
  gpuNodeId: string | null = gpu > 0 ? NODE : null,
) {
  return {
    appGroup: {
      id: "00000000-0000-4000-8000-000000000001",
      tenantId: "00000000-0000-4000-8000-000000000002",
      name: "test",
      runtimeState: "Running",
      runtimeDraftRevision: 1,
    },
    singleApps: [{
      id: "00000000-0000-4000-8000-000000000003",
      name: "model",
      image: "alpine:3.20",
      registryId: null,
      desiredReplicas: 1,
      runtimeState: "Running",
      resources: {
        cpu: "0.5",
        memoryBytes: "268435456",
        gpu,
        gpuUuid,
        gpuNodeId,
      },
      environment: { NVIDIA_VISIBLE_DEVICES: "all", FOO: "bar" },
      variables: [],
      configs: [],
      secrets: [],
      volumes: [],
      httpEndpoints: [],
      healthCheck: null,
      entrypoint: null,
      command: [],
      workingDir: null,
      user: null,
      readOnlyRootFilesystem: true,
      stopGracePeriodSeconds: 30,
      restartPolicy: {},
      updatePolicy: {},
    }],
  };
}

const render = (config: unknown) => {
  const service = Object.create(DeploymentExecutionService.prototype) as {
    renderStack: (value: string) => string;
  };
  const yaml = service.renderStack(JSON.stringify(config));
  return {
    yaml,
    parsed: parse(yaml) as {
      services: Record<string, {
        environment: Record<string, string>;
        deploy: {
          replicas: number;
          resources: {
            reservations?: {
              generic_resources: Array<{
                discrete_resource_spec?: { kind: string; value: number };
                named_resource_spec?: { kind: string; value: string };
              }>;
            };
          };
          placement: { constraints: string[] };
        };
      }>;
    },
  };
};

describe("dedicated NVIDIA GPU Swarm isolation", () => {
  it("uses a supported discrete reservation, exact node affinity and exact UUID visibility", () => {
    const { yaml, parsed } = render(snapshot(1, GPU));
    const app = parsed.services.model;

    expect(app.environment.NVIDIA_VISIBLE_DEVICES).toBe(GPU);
    expect(app.environment.FOO).toBe("bar");
    expect(app.deploy.replicas).toBe(1);
    expect(app.deploy.resources.reservations?.generic_resources).toEqual([{
      discrete_resource_spec: { kind: "NVIDIA-GPU", value: 1 },
    }]);
    expect(app.deploy.placement.constraints).toContain(`node.id == ${NODE}`);
    expect(yaml).not.toContain("named_resource_spec");
  });

  it("does not give GPU visibility, reservation or node affinity to CPU-only tenants", () => {
    const app = render(snapshot(0)).parsed.services.model;
    expect(app.environment.NVIDIA_VISIBLE_DEVICES).toBe("void");
    expect(app.deploy.resources.reservations).toBeUndefined();
    expect(app.deploy.placement.constraints).not.toContain(`node.id == ${NODE}`);
  });

  it("refuses to render a GPU demand without a dedicated UUID", () => {
    expect(() => render(snapshot(1))).toThrow("GpuNotAvailable");
  });

  it("refuses to render a GPU demand without a verified Swarm node", () => {
    expect(() => render(snapshot(1, GPU, null))).toThrow("GpuNotAvailable");
  });
});
