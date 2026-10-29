import { DeploymentExecutionService } from "../src/internal/deployment-execution.service";

const nodeId = process.env.RP_GPU_SCHEMA_NODE_ID ?? "";
if (!/^[a-z0-9]{20,64}$/.test(nodeId)) {
  throw new Error("RP_GPU_SCHEMA_NODE_ID must contain a valid Swarm node ID");
}

const gpuUuid = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const snapshot = {
  appGroup: {
    id: "00000000-0000-4000-8000-000000000001",
    tenantId: "00000000-0000-4000-8000-000000000002",
    name: "gpu-schema",
    runtimeState: "Running",
    runtimeDraftRevision: 1,
  },
  singleApps: [{
    id: "00000000-0000-4000-8000-000000000003",
    name: "gpu-schema",
    image: "alpine:3.20",
    registryId: null,
    desiredReplicas: 1,
    runtimeState: "Running",
    resources: {
      cpu: "0.1",
      memoryBytes: "67108864",
      gpu: 1,
      gpuUuid,
      gpuNodeId: nodeId,
    },
    environment: {},
    variables: [],
    configs: [],
    secrets: [],
    volumes: [],
    httpEndpoints: [],
    healthCheck: null,
    entrypoint: null,
    command: ["sleep", "60"],
    workingDir: null,
    user: null,
    readOnlyRootFilesystem: true,
    stopGracePeriodSeconds: 5,
    restartPolicy: { condition: "none" },
    updatePolicy: {},
  }],
};

const service = Object.create(DeploymentExecutionService.prototype) as {
  renderStack: (stackConfig: string) => string;
};

process.stdout.write(service.renderStack(JSON.stringify(snapshot)));
