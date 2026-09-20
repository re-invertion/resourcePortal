import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { StackRolloutService } from "./stack-rollout.service";

type DockerChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function hangingDockerProcess() {
  const child = new EventEmitter() as DockerChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function dockerProcess(stdout: string) {
  const child = hangingDockerProcess();
  queueMicrotask(() => {
    child.stdout.write(stdout);
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
}

describe("StackRolloutService docker command timeout", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds a hung docker stack services inspection", async () => {
    const child = hangingDockerProcess();
    spawnMock.mockReturnValueOnce(child);
    const config = {
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "DOCKER_RUNTIME_OPERATION_TIMEOUT_MS") return "50";
        if (key === "DOCKER_ROLLOUT_TIMEOUT_MS") return "500";
        return fallback;
      }),
    };
    const service = new StackRolloutService(config as unknown as ConfigService);

    const resultPromise = service.waitForRollout({
      stackName: "rp_test",
      expectedServices: [{ name: "rp_test_web", desiredReplicas: 1 }],
    });

    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.message).toBe("Docker stack services failed");
    expect(result.details).toContain("timed out after 50ms");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("honors a rollout deadline provided through string environment values", async () => {
    spawnMock.mockImplementation(() =>
      dockerProcess('{"Name":"rp_test_web","Replicas":"0/1"}\n'),
    );
    const config = {
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "DOCKER_RUNTIME_OPERATION_TIMEOUT_MS") return "100";
        if (key === "DOCKER_ROLLOUT_TIMEOUT_MS") return "50";
        if (key === "DOCKER_ROLLOUT_POLL_INTERVAL_MS") return "10";
        return fallback;
      }),
    };
    const service = new StackRolloutService(config as unknown as ConfigService);

    const resultPromise = service.waitForRollout({
      stackName: "rp_test",
      expectedServices: [{ name: "rp_test_web", desiredReplicas: 1 }],
    });

    await vi.advanceTimersByTimeAsync(70);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.message).toBe("Rollout timed out");
    expect(spawnMock.mock.calls.length).toBeGreaterThan(1);
  });
});
