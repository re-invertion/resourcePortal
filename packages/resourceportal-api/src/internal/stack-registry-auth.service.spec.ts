import { ConfigService } from "@nestjs/config";
import { RegistryAuthType } from "@prisma/client";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { StackRegistryAuthService } from "./stack-registry-auth.service";

function successfulDockerProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
    final(callback) {
      callback();
      queueMicrotask(() => child.emit("close", 0, null));
    },
  });
  return child;
}

describe("StackRegistryAuthService", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => successfulDockerProcess());
  });

  it("uses a stable placeholder username when a token registry has no username", async () => {
    const config = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    };
    const service = new StackRegistryAuthService(
      config as unknown as ConfigService,
    );

    const result = await service.login([
      {
        host: "registry.example.com",
        authType: RegistryAuthType.Token,
        username: null,
        credential: "opaque-token",
      },
    ]);

    expect(result.success).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "docker",
      [
        "login",
        "registry.example.com",
        "--username",
        "token",
        "--password-stdin",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  it("still rejects incomplete username/password credentials", async () => {
    const config = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    };
    const service = new StackRegistryAuthService(
      config as unknown as ConfigService,
    );

    const result = await service.login([
      {
        host: "registry.example.com",
        authType: RegistryAuthType.UsernamePassword,
        username: null,
        credential: "secret",
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.message).toContain("credentials are incomplete");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
