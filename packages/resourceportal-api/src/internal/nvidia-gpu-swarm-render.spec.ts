import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DeploymentExecutionService } from "./deployment-execution.service";

const GPU = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function snapshot(gpu: number, gpuUuid: string | null = null) {
  return {
    appGroup: {
      id: "00000000-0000-4000-8000-000000000001",
      tenantId: "00000000-0000-4000-8000-000000000002",
      name: "test", runtimeState: "Running", runtimeDraftRevision: 1,
    },
    singleApps: [{
      id: "00000000-0000-4000-8000-000000000003", name: "model", image: "alpine:3.20",
      registryId: null, desiredReplicas: 1, runtimeState: "Running",
      resources: { cpu: "0.5", memoryBytes: "268435456", gpu, gpuUuid },
      environment: { NVIDIA_VISIBLE_DEVICES: "all", FOO: "bar" },
      variables: [], configs: [], secrets: [], volumes: [], httpEndpoints: [], healthCheck: null,
      entrypoint: null, command: [], workingDir: null, user: null,
      readOnlyRootFilesystem: true, stopGracePeriodSeconds: 30,
      restartPolicy: {}, updatePolicy: {},
    }],
  };
}
const render = (config: unknown) => {
  const service = Object.create(DeploymentExecutionService.prototype) as {
    renderStack: (value: string) => string;
  };
  return parse(service.renderStack(JSON.stringify(config))) as {
    services: Record<string, {
      environment: Record<string, string>;
      deploy: {
        replicas: number;
        resources: { reservations?: { generic_resources: Array<{
          named_resource_spec: { kind: string; value: string };
        }> } };
      };
    }>;
  };
};
describe("dedicated NVIDIA GPU Swarm isolation", () => {
  it("reserves the exact GPU by named generic resource and overrides tenant environment", () => {
    const config = render(snapshot(1, GPU));
    const app = config.services.model;
    expect(app.environment.NVIDIA_VISIBLE_DEVICES).toBe(GPU);
    expect(app.environment.FOO).toBe("bar");
    expect(app.deploy.replicas).toBe(1);
    expect(app.deploy.resources.reservations?.generic_resources).toEqual([{
      named_resource_spec: { kind: "NVIDIA-GPU", value: GPU },
    }]);
  });
  it("does not give any GPU visibility or generic reservation to CPU-only tenants", () => {
    const app = render(snapshot(0)).services.model;
    expect(app.environment.NVIDIA_VISIBLE_DEVICES).toBe("void");
    expect(app.deploy.resources.reservations).toBeUndefined();
  });
  it("refuses to render a GPU demand that has no dedicated UUID", () => {
    expect(() => render(snapshot(1))).toThrow("GpuNotAvailable");
  });
});
