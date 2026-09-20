import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { StackRuntimeService } from "./stack-runtime.service";

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
  return new StackRuntimeService({
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
  } as unknown as ConfigService);
}

describe("StackRuntimeService observed service state", () => {
  beforeEach(() => spawnMock.mockReset());

  it("separates running replicas from Swarm desired replicas", async () => {
    spawnMock.mockImplementationOnce(() =>
      dockerProcess(
        JSON.stringify({
          Name: "rp_stack_web",
          Image: "nginx:1.29@sha256:abc",
          Replicas: "2/3",
        }),
      ),
    );

    await expect(service().inspectStackServices("rp_stack")).resolves.toEqual([
      {
        name: "rp_stack_web",
        image: "nginx:1.29@sha256:abc",
        runningReplicas: 2,
        desiredReplicas: 3,
      },
    ]);
  });

  it("returns unknown rather than inventing state for malformed Docker output", async () => {
    spawnMock.mockImplementationOnce(() =>
      dockerProcess(
        JSON.stringify({ Name: "rp_stack_web", Image: "nginx", Replicas: "bad" }),
      ),
    );
    await expect(service().inspectStackServices("rp_stack")).resolves.toBeNull();
  });
});
