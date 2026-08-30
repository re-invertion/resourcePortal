import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

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
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
  };
  return new StackRuntimeService(config as unknown as ConfigService);
}

describe("StackRuntimeService.reconcileTraefikLabels", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("removes only stale traefik labels and preserves unrelated service labels", async () => {
    spawnMock
      .mockImplementationOnce(() =>
        dockerProcess(
          JSON.stringify({
            "com.example.keep": "yes",
            "traefik.http.routers.old.rule": "Host(`old.example.com`)",
            "traefik.http.services.web.loadbalancer.server.port": "8080",
          }),
        ),
      )
      .mockImplementationOnce(() => dockerProcess());

    const result = await service().reconcileTraefikLabels({
      serviceName: "rp_stack_web",
      desiredLabels: {
        "traefik.http.services.web.loadbalancer.server.port": "8080",
      },
    });

    expect(result).toEqual({ success: true, changed: true });
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      [
        "service",
        "update",
        "--label-rm",
        "traefik.http.routers.old.rule",
        "rp_stack_web",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("adds changed desired traefik labels without touching non-traefik labels", async () => {
    spawnMock
      .mockImplementationOnce(() =>
        dockerProcess(JSON.stringify({ "com.example.keep": "yes" })),
      )
      .mockImplementationOnce(() => dockerProcess());

    const result = await service().reconcileTraefikLabels({
      serviceName: "rp_stack_web",
      desiredLabels: {
        "traefik.http.routers.web.rule": "Host(`app.example.com`)",
      },
    });

    expect(result).toEqual({ success: true, changed: true });
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      [
        "service",
        "update",
        "--label-add",
        "traefik.http.routers.web.rule=Host(`app.example.com`)",
        "rp_stack_web",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("is idempotent when current and desired traefik labels already match", async () => {
    spawnMock.mockImplementationOnce(() =>
      dockerProcess(
        JSON.stringify({
          "traefik.http.routers.web.rule": "Host(`app.example.com`)",
        }),
      ),
    );

    const result = await service().reconcileTraefikLabels({
      serviceName: "rp_stack_web",
      desiredLabels: {
        "traefik.http.routers.web.rule": "Host(`app.example.com`)",
      },
    });

    expect(result).toEqual({ success: true, changed: false });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
