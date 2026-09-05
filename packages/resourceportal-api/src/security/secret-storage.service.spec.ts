import { ConfigService } from "@nestjs/config";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EncryptionService } from "./encryption.service";
import { SecretStorageService } from "./secret-storage.service";

describe("SecretStorageService", () => {
  let root: string;
  let service: SecretStorageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "resource-portal-secrets-"));
    const config = {
      get: (key: string, fallback?: string) =>
        key === "RESOURCE_STORAGE_BASE_PATH" ? root : fallback,
    } as unknown as ConfigService;

    service = new SecretStorageService(config, new EncryptionService(config));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });


  it("uses the protected Wiki Secret namespace by default", () => {
    const config = { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
    const storage = new SecretStorageService(config, new EncryptionService(config));
    expect(storage.path("tenant-a", "app-a", "api-key")).toBe(
      "/srv/resource-portal/storage/secrets/tenant-a/app-a/api-key",
    );
  });
  it("stores an encrypted envelope and reads the original bytes", async () => {
    const path = service.path("tenant-id", "app-group-id", "api-key");

    await service.replaceAtomically(path, Buffer.from("plain-value"), () =>
      Promise.resolve("persisted"),
    );

    const stored = await readFile(path, "utf8");
    expect(stored).not.toContain("plain-value");
    expect(JSON.parse(stored)).toMatchObject({
      version: 1,
      algorithm: "AES-256-GCM",
      keyVersion: 1,
    });
    expect(await service.read(path)).toEqual(Buffer.from("plain-value"));
  });

  it("supports an empty secret without treating its ciphertext as missing", async () => {
    const path = service.path("tenant-id", "app-group-id", "empty");

    await service.replaceAtomically(path, Buffer.alloc(0), () =>
      Promise.resolve(undefined),
    );

    expect(await service.read(path)).toEqual(Buffer.alloc(0));
  });

  it("rejects a name that would resolve to the AppGroup directory", () => {
    expect(() => service.path("tenant-id", "app-group-id", ".")).toThrow(
      "Invalid Secret storage name",
    );
  });

  it("restores the previous encrypted value when persistence fails", async () => {
    const path = service.path("tenant-id", "app-group-id", "api-key");
    await service.replaceAtomically(path, Buffer.from("old-value"), () =>
      Promise.resolve(undefined),
    );

    await expect(
      service.replaceAtomically(path, Buffer.from("new-value"), () =>
        Promise.reject(new Error("database failure")),
      ),
    ).rejects.toThrow("database failure");

    expect(await service.read(path)).toEqual(Buffer.from("old-value"));
  });

  it("restores a deleted file when persistence fails", async () => {
    const path = service.path("tenant-id", "app-group-id", "api-key");
    await service.replaceAtomically(path, Buffer.from("kept-value"), () =>
      Promise.resolve(undefined),
    );

    await expect(
      service.deleteAtomically(path, () =>
        Promise.reject(new Error("database failure")),
      ),
    ).rejects.toThrow("database failure");

    expect(await service.read(path)).toEqual(Buffer.from("kept-value"));
  });
});
