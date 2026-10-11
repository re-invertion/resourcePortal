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
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env: { DOCKER_CONFIG: string } };
    expect(typeof spawnOptions.env.DOCKER_CONFIG).toBe("string");
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

describe("tenant registry credentials are isolated per deployment (#218)", () => {
  const tokenFor = (tenant: string) => ({
    host: "same-registry.example.com",
    authType: RegistryAuthType.Token,
    username: tenant,
    credential: `secret-for-${tenant}`,
  });
  it("uses different temporary Docker stores in concurrent deployments and removes both", async () => {
    const { stat } = await import("node:fs/promises");
    const service = new StackRegistryAuthService({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    } as unknown as ConfigService);
    const seen: string[] = [];
    const execute = async (tenant: string) =>
      service.withScopedLogin([tokenFor(tenant)], async (path) => {
        const config = await stat(path);
        expect(config.mode & 0o777).toBe(0o700);
        seen.push(path);
        await Promise.resolve();
        return tenant;
      });
    const [a, b] = await Promise.all([execute("A"), execute("B")]);
    expect([a.auth.success, b.auth.success]).toEqual([true, true]);
    expect([a.result, b.result]).toEqual(["A", "B"]);
    expect(seen[0]).not.toBe(seen[1]);
    const passedPaths = spawnMock.mock.calls.map((call: unknown[]) =>
      (call[2] as { env: { DOCKER_CONFIG: string } }).env.DOCKER_CONFIG,
    );
    expect(passedPaths).toEqual(expect.arrayContaining(seen));
    for (const path of seen) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cleans the private Docker store even if the stack operation throws", async () => {
    const { stat } = await import("node:fs/promises");
    const service = new StackRegistryAuthService({
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    } as unknown as ConfigService);
    let path = "";
    await expect(service.withScopedLogin([tokenFor("A")], (configDir) => {
      path = configDir;
      return Promise.reject(new Error("stack apply failed"));
    })).rejects.toThrow("stack apply failed");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
