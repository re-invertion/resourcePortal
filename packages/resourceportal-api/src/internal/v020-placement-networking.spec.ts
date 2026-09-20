import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { DeploymentExecutionService } from "./deployment-execution.service";

type StackService = {
  networks?: string[];
  labels?: Record<string, string>;
  ports?: Array<{ target: number; published: number; protocol: string; mode: string }>;
  deploy: {
    placement: { constraints: string[]; max_replicas_per_node?: number };
    labels?: Record<string, string>;
  };
};

type ParsedStack = {
  networks: Record<string, unknown>;
  services: Record<string, StackService>;
};

type UpdateManyArgs = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

function app(overrides: Record<string, unknown>) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "app",
    image: "nginx:alpine",
    registryId: null,
    desiredReplicas: 1,
    runtimeState: "Running",
    resources: { cpu: "0.5", memoryBytes: "134217728", gpu: 0 },
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
    stopGracePeriodSeconds: 10,
    restartPolicy: {},
    updatePolicy: {},
    httpEndpoints: [],
    volumes: [],
    ...overrides,
  };
}

function serviceWithPrisma(prisma: PrismaService) {
  return new DeploymentExecutionService(
    prisma,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

async function renderStack(stackConfig: string) {
  const state = {
    id: "deployment-render-test",
    stackConfig,
    renderedStack: null as string | null,
    renderedStackSha256: null as string | null,
    renderedAt: null as Date | null,
  };
  const updateMany = vi.fn((args: UpdateManyArgs) => {
    if (typeof args.data.renderedStack === "string") {
      state.renderedStack = args.data.renderedStack;
    }
    if (typeof args.data.renderedStackSha256 === "string") {
      state.renderedStackSha256 = args.data.renderedStackSha256;
    }
    if (args.data.renderedAt instanceof Date) state.renderedAt = args.data.renderedAt;
    return Promise.resolve({ count: 1 });
  });
  const prisma = {
    appGroupDeployment: {
      findUnique: vi.fn(() => Promise.resolve({ ...state })),
      updateMany,
      findUniqueOrThrow: vi.fn(() =>
        Promise.resolve({
          renderedStack: state.renderedStack,
          renderedStackSha256: state.renderedStackSha256,
        }),
      ),
    },
  } as unknown as PrismaService;
  const artifact = await serviceWithPrisma(prisma).ensureDeploymentArtifact(state.id);
  return artifact.renderedStack;
}

function parsedStack(rendered: string) {
  const value: unknown = parse(rendered);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected rendered stack object");
  }
  return value as ParsedStack;
}

describe("v0.2 tenant placement and App Group network rendering", () => {
  it("isolates an App Group and exposes only the service that actually has a domain", async () => {
    const appGroupId = "11111111-1111-4111-8111-111111111111";
    const rendered = await renderStack(
      JSON.stringify({
        appGroup: {
          id: appGroupId,
          tenantId: "22222222-2222-4222-8222-222222222222",
          name: "group",
          runtimeState: "Running",
          runtimeDraftRevision: 1,
        },
        singleApps: [
          app({
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            name: "public-web",
            httpEndpoints: [
              {
                id: "endpoint-1",
                name: "http",
                containerPort: 8080,
                protocolMode: "HTTPS",
                domains: [
                  {
                    id: "domain-1",
                    hostname: "app.example.com",
                    tlsEnabled: true,
                    dnsStatus: "Verified",
                    certificateStatus: "Ready",
                  },
                ],
              },
            ],
          }),
          app({
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            name: "private-api",
            volumes: [
              {
                id: "attachment-1",
                volumeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                volumeName: "data",
                storagePath: "/legacy/unused",
                mountPath: "/data",
                mode: "ReadWrite",
              },
            ],
          }),
        ],
      }),
    );

    const stack = parsedStack(rendered);
    expect(stack.networks).toEqual({
      default: {
        external: true,
        name: `rp-appgroup-${appGroupId}`,
      },
    });

    expect(stack.services.public_web.networks).toEqual(["default"]);
    expect(stack.services.private_api.networks).toEqual(["default"]);
    expect(stack.services.public_web.labels).toEqual({
      "resourceportal.workload": "tenant",
      "resourceportal.app-group-id": appGroupId,
      "resourceportal.tenant-id": "22222222-2222-4222-8222-222222222222",
    });
    expect(stack.services.private_api.labels).toEqual({
      "resourceportal.workload": "tenant",
      "resourceportal.app-group-id": appGroupId,
      "resourceportal.tenant-id": "22222222-2222-4222-8222-222222222222",
    });
    expect(stack.services.public_web.deploy.placement.constraints).toEqual([
      "node.labels.rp.node.tenant-workloads == true",
    ]);
    expect(stack.services.private_api.deploy.placement.constraints).toEqual([
      "node.labels.rp.node.tenant-workloads == true",
      "node.labels.rp.node.storage == true",
      "node.labels.resourceportal.storage.volumes == true",
    ]);
    expect(stack.services.public_web.deploy.labels).toMatchObject({
      "traefik.enable": "true",
      "traefik.swarm.network": `rp-appgroup-${appGroupId}`,
    });
    expect(stack.services.private_api.deploy.labels).toBeUndefined();
    expect(rendered).not.toContain("rp-control");
    expect(rendered).not.toContain("resourceportal-control-plane_rp-ingress");
    expect(rendered).not.toContain(`rp-ingress-${appGroupId}`);
  });

  it("does not create an ingress network for endpoints without a domain", async () => {
    const appGroupId = "33333333-3333-4333-8333-333333333333";
    const rendered = await renderStack(
      JSON.stringify({
        appGroup: {
          id: appGroupId,
          tenantId: "44444444-4444-4444-8444-444444444444",
          name: "private-group",
          runtimeState: "Running",
          runtimeDraftRevision: 1,
        },
        singleApps: [
          app({
            name: "internal-web",
            httpEndpoints: [
              {
                id: "endpoint-2",
                name: "http",
                containerPort: 8080,
                protocolMode: "HTTP",
                domains: [],
              },
            ],
          }),
        ],
      }),
    );
    const stack = parsedStack(rendered);
    expect(stack.networks).toEqual({
      default: {
        external: true,
        name: `rp-appgroup-${appGroupId}`,
      },
    });
    expect(stack.services.internal_web.networks).toEqual(["default"]);
    expect(stack.services.internal_web.deploy.labels).toBeUndefined();
  });
  it("publishes privileged App Group internal ports in host mode with guard metadata", async () => {
    const appGroupId = "55555555-5555-4555-8555-555555555555";
    const rendered = await renderStack(
      JSON.stringify({
        appGroup: {
          id: appGroupId,
          tenantId: "66666666-6666-4666-8666-666666666666",
          name: "dns",
          runtimeState: "Running",
          runtimeDraftRevision: 2,
        },
        singleApps: [
          app({
            name: "dns-server",
            internalPortExposures: [
              {
                id: "77777777-7777-4777-8777-777777777777",
                name: "dns-udp",
                containerPort: 53,
                publishedPort: 53,
                protocol: "udp",
              },
            ],
          }),
        ],
      }),
    );
    const stack = parsedStack(rendered);
    expect(stack.services.dns_server.ports).toEqual([
      { target: 53, published: 53, protocol: "udp", mode: "host" },
    ]);
    expect(
      stack.services.dns_server.deploy.placement.max_replicas_per_node,
    ).toBe(1);
    expect(
      stack.services.dns_server.labels?.["resourceportal.network-privileged"],
    ).toBeUndefined();
    const encoded =
      stack.services.dns_server.labels?.[
        "resourceportal.internal-port-exposures-b64"
      ];
    expect(encoded).toBeTruthy();
    expect(JSON.parse(Buffer.from(encoded ?? "", "base64").toString("utf8"))).toEqual([
      { publishedPort: 53, protocol: "udp" },
    ]);
  });

});
