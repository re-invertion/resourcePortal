import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutionService } from "./deployment-execution.service";

const GROUP = "group-1";
const TENANT = "tenant-1";
const DOMAIN = "domain-1";

function snapshot() {
  return {
    appGroup: {
      id: GROUP, tenantId: TENANT, name: "showcase",
      runtimeState: "Stopped", runtimeDraftRevision: 1,
    },
    singleApps: [{
      id: "app-1", name: "web", image: "nginx:alpine",
      registryId: null, desiredReplicas: 1, runtimeState: "Running",
      resources: { cpu: "0.5", memoryBytes: "2147483648", gpu: 0 },
      environment: {}, variables: [], secrets: [], configs: [],
      healthCheck: null, entrypoint: null, command: [],
      workingDir: null, user: null, readOnlyRootFilesystem: false,
      stopGracePeriodSeconds: 30, restartPolicy: {}, updatePolicy: {},
      httpEndpoints: [{
        id: "endpoint-1", name: "public", containerPort: 8080,
        protocolMode: "HTTPS",
        domains: [{
          id: DOMAIN, hostname: "app.example.com", tlsEnabled: true,
          dnsStatus: "Valid", certificateStatus: "Valid",
        }],
      }],
      volumes: [], networkAttachments: [],
    }],
  };
}

type Snapshot = ReturnType<typeof snapshot>;

function worker(previous: Snapshot | null = snapshot()) {
  const prisma = {
    appGroup: {
      findUnique: vi.fn().mockResolvedValue({
        id: GROUP, tenantId: TENANT, runtimeState: "Stopped",
        currentDeploymentVersion: 6, status: "Ready",
        tenant: { status: "Active", quota: null },
      }),
    },
    domain: {
      // Domain record lost ownership after the previous successful deploy.
      findMany: vi.fn().mockResolvedValue([{
        id: DOMAIN, hostname: "app.example.com", tenantId: TENANT,
        customRootDomain: null,
      }]),
    },
    appGroupDeployment: {
      findUnique: vi.fn().mockResolvedValue(previous ? {
        status: "Succeeded", stackConfig: JSON.stringify(previous),
      } : null),
    },
  };
  const service = new DeploymentExecutionService(
    prisma as never,
    undefined as never, undefined as never, undefined as never,
    undefined as never, undefined as never, undefined as never,
    undefined as never, undefined as never, undefined as never,
  );
  const execute = service as unknown as {
    validateDeploymentSnapshot: (deployment: {
      appGroupId: string; stackConfig: string; rollbackTargetVersion: number | null;
    }) => Promise<{ success: boolean; errorCode?: string }>;
    renderStack: (stackConfig: string) => string;
  };
  const validate = (next: Snapshot, rollbackTargetVersion: number | null = null) =>
    execute.validateDeploymentSnapshot({
      appGroupId: GROUP, stackConfig: JSON.stringify(next), rollbackTargetVersion,
    });
  return { prisma, execute, validate };
}

describe("stopped App Group resource-only update with stale domain (#377)", () => {
  it("accepts reduced CPU/RAM for an unchanged previously deployed stopped stack", async () => {
    const { prisma, execute, validate } = worker();
    const next = snapshot();
    next.appGroup.runtimeDraftRevision = 2;
    next.singleApps[0].resources.memoryBytes = "536870912";
    next.singleApps[0].resources.cpu = "0.25";
    await expect(validate(next)).resolves.toEqual({ success: true });
    expect(prisma.appGroupDeployment.findUnique).toHaveBeenCalledWith({
      where: { appGroupId_version: { appGroupId: GROUP, version: 6 } },
      select: { status: true, stackConfig: true },
    });
    const stack = parse(execute.renderStack(JSON.stringify(next))) as {
      services: Record<string, { deploy: { replicas: number; labels?: Record<string, string> } }>;
    };
    expect(stack.services.web.deploy.replicas).toBe(0);
    expect(stack.services.web.deploy.labels).toBeUndefined();
  });

  it("ignores independent DNS and certificate health drift during a stopped CPU/RAM-only update", async () => {
    const { validate } = worker();
    const next = snapshot();
    next.appGroup.runtimeDraftRevision = 2;
    next.singleApps[0].resources.memoryBytes = "536870912";
    next.singleApps[0].httpEndpoints[0].domains[0].dnsStatus = "Invalid";
    next.singleApps[0].httpEndpoints[0].domains[0].certificateStatus = "Error";
    await expect(validate(next)).resolves.toEqual({ success: true });
  });

  it("requires current ownership again when the group is started", async () => {
    const { prisma, validate } = worker();
    const next = snapshot();
    next.appGroup.runtimeState = "Running";
    next.singleApps[0].resources.memoryBytes = "536870912";
    await expect(validate(next)).resolves.toMatchObject({
      success: false, errorCode: "DomainOwnershipNotVerified",
    });
    expect(prisma.appGroupDeployment.findUnique).not.toHaveBeenCalled();
  });

  it("rejects changed domain attachments even if services remain stopped", async () => {
    const { validate } = worker();
    const next = snapshot();
    next.appGroup.runtimeDraftRevision = 2;
    next.singleApps[0].resources.memoryBytes = "536870912";
    next.singleApps[0].httpEndpoints[0].domains[0].hostname = "changed.example.com";
    await expect(validate(next)).resolves.toMatchObject({
      success: false, errorCode: "DomainOwnershipNotVerified",
    });
  });

  it("rejects changes unrelated to CPU/RAM, including image changes", async () => {
    const { validate } = worker();
    const next = snapshot();
    next.singleApps[0].resources.memoryBytes = "536870912";
    next.singleApps[0].image = "alpine:latest";
    await expect(validate(next)).resolves.toMatchObject({
      success: false, errorCode: "DomainOwnershipNotVerified",
    });
  });

  it("fails closed without a previous successful snapshot", async () => {
    const { validate } = worker(null);
    const next = snapshot();
    next.singleApps[0].resources.memoryBytes = "536870912";
    await expect(validate(next)).resolves.toMatchObject({
      success: false, errorCode: "DomainOwnershipNotVerified",
    });
  });

  it("does not exempt explicit rollback deployments", async () => {
    const { validate } = worker();
    const next = snapshot();
    next.singleApps[0].resources.memoryBytes = "536870912";
    await expect(validate(next, 4)).resolves.toMatchObject({
      success: false, errorCode: "DomainOwnershipNotVerified",
    });
  });

  it("rejects unchanged configurations: exemption is only for resource edits", async () => {
    const { validate } = worker();
    await expect(validate(snapshot())).resolves.toMatchObject({
      success: false, errorCode: "DomainOwnershipNotVerified",
    });
  });

  it("does not publish routes for stopped SingleApps when the group is running", () => {
    const { execute } = worker();
    const next = snapshot();
    next.appGroup.runtimeState = "Running";
    next.singleApps[0].runtimeState = "Stopped";
    const stack = parse(execute.renderStack(JSON.stringify(next))) as {
      services: Record<string, { deploy: { replicas: number; labels?: Record<string, string> } }>;
    };
    expect(stack.services.web.deploy.replicas).toBe(0);
    expect(stack.services.web.deploy.labels).toBeUndefined();
  });
});
