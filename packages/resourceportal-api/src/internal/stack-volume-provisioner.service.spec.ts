import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  parseStorageNode,
  StackVolumeProvisionerService,
} from "./stack-volume-provisioner.service";

function dockerProcess(stdout = "", exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", exitCode, null);
  });
  return child;
}

function service() {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        DOCKER_CONTEXT: "default",
        DOCKER_VOLUME_PROVISION_TIMEOUT_MS: 1000,
        RESOURCE_VOLUME_RUNTIME_ROOT: "/mnt/resourceportal/volumes",
        STORAGE_REMOTE_VALIDATION_IMAGE: "alpine:3.20",
      };
      return values[key] ?? fallback;
    }),
  };
  return new StackVolumeProvisionerService(config as unknown as ConfigService);
}

describe("StackVolumeProvisionerService", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("parses Swarm storage readiness from node status and label", () => {
    expect(parseStorageNode("node-a|Ready|true")).toEqual({
      id: "node-a",
      ready: true,
      volumesReady: true,
    });
    expect(parseStorageNode("node-b|Ready|false")).toEqual({
      id: "node-b",
      ready: true,
      volumesReady: false,
    });
    expect(parseStorageNode("node-c|Down|true")).toEqual({
      id: "node-c",
      ready: false,
      volumesReady: true,
    });
  });

  it("validates only Ready nodes carrying the volumes readiness label", async () => {
    spawnMock
      .mockImplementationOnce(() =>
        dockerProcess("node-a|Ready|true\nnode-b|Ready|false\nnode-c|Down|true\n"),
      )
      .mockImplementationOnce(() => dockerProcess("probe-service\n"))
      .mockImplementationOnce(() => dockerProcess("Complete 1 second ago|\n"))
      .mockImplementationOnce(() => dockerProcess());

    await expect(
      service().provisionVolumes([
        {
          dockerVolumeName: "rp_vol_123",
          storagePath: "/srv/resource-portal/storage/volumes/tenant-a/volume-a",
        },
      ]),
    ).resolves.toMatchObject({ success: true });

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "docker",
      [
        "--context",
        "default",
        "node",
        "ls",
        "--format",
        '{{.ID}}|{{.Status}}|{{index .Labels "resourceportal.storage.volumes"}}',
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("probes the canonical runtime root with a bind mount and storage constraint", async () => {
    spawnMock
      .mockImplementationOnce(() => dockerProcess("node-a|Ready|true\n"))
      .mockImplementationOnce(() => dockerProcess("probe-service\n"))
      .mockImplementationOnce(() => dockerProcess("Complete 1 second ago|\n"))
      .mockImplementationOnce(() => dockerProcess());

    await expect(
      service().provisionVolumes([
        {
          dockerVolumeName: "rp_vol_123",
          storagePath: "/srv/resource-portal/storage/volumes/tenant-a/volume-a",
        },
      ]),
    ).resolves.toMatchObject({ success: true });

    const createCall = spawnMock.mock.calls.find((call) => {
      const args = call[1] as string[];
      return args.includes("service") && args.includes("create");
    });
    expect(createCall).toBeDefined();
    const createArgs = (createCall?.[1] as string[] | undefined) ?? [];
    const mountIndex = createArgs.indexOf("--mount");
    expect(createArgs[mountIndex + 1]).toBe(
      "type=bind,source=/mnt/resourceportal/volumes,target=/probe",
    );
    expect(createArgs).toContain("node.labels.resourceportal.storage.volumes==true");
    expect(createArgs.join(" ")).not.toContain("volume-driver=local");
    expect(createArgs.join(" ")).not.toContain(":/rp/");
  });

  it("fails closed when no Ready storage node is eligible", async () => {
    spawnMock.mockImplementationOnce(() =>
      dockerProcess("node-a|Ready|false\nnode-b|Down|true\n"),
    );

    await expect(
      service().provisionVolumes([
        {
          dockerVolumeName: "rp_vol_123",
          storagePath: "/srv/resource-portal/storage/volumes/tenant-a/volume-a",
        },
      ]),
    ).resolves.toMatchObject({
      success: false,
      message: "No Ready Swarm nodes with Volume storage readiness",
    });
  });
});
