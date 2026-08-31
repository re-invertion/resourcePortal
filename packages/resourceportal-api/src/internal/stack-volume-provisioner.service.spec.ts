import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { StackVolumeProvisionerService } from "./stack-volume-provisioner.service";

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
    if (stdout) {
      child.stdout.write(stdout);
    }
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
        NFS_GANESHA_SERVER: "10.0.0.15",
        NFS_GANESHA_VERSION: "4.1",
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

  it("lists all Swarm nodes and provisions only across Ready nodes", async () => {
    spawnMock
      .mockImplementationOnce(() =>
        dockerProcess("node-a|Ready\nnode-b|Down\nnode-c|Ready\n"),
      )
      .mockImplementationOnce(() => dockerProcess("probe-service\n"))
      .mockImplementationOnce(() =>
        dockerProcess("Complete 1 second ago|\nComplete 1 second ago|\n"),
      )
      .mockImplementationOnce(() => dockerProcess());

    await expect(
      service().provisionVolumes([
        {
          dockerVolumeName: "rp_vol_123",
          storagePath: "/rp/volumes/tenant-a/volume-a",
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
        "{{.ID}}|{{.Status}}",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("quotes comma-separated local-driver NFS options for the probe service", async () => {
    spawnMock
      .mockImplementationOnce(() => dockerProcess("node-a|Ready\n"))
      .mockImplementationOnce(() => dockerProcess("probe-service\n"))
      .mockImplementationOnce(() => dockerProcess("Complete 1 second ago|\n"))
      .mockImplementationOnce(() => dockerProcess());

    await expect(
      service().provisionVolumes([
        {
          dockerVolumeName: "rp_vol_123",
          storagePath: "/rp/volumes/tenant-a/volume-a",
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
      'type=volume,source=rp_vol_123,target=/probe,volume-driver=local,volume-opt=type=nfs,volume-opt=device=:/rp/volumes/tenant-a/volume-a,"volume-opt=o=addr=10.0.0.15,nfsvers=4.1,rw"',
    );
  });
});
