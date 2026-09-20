import { ConfigService } from "@nestjs/config";
import { mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EncryptionService } from "./encryption.service";
import { PrismaService } from "../prisma/prisma.service";
import { LegacySecretMigrationService } from "./legacy-secret-migration.service";
import { SecretStorageService } from "./secret-storage.service";

type SecretRow = {
  id: string;
  createdAt: Date;
  valueVersion: number;
  valueCiphertext: string | null;
  storagePath: string | null;
  keyVersion: number;
};

type SecretFindManyArgs = {
  where: { id?: { notIn: string[] } };
  take: number;
};

type SecretFindUniqueArgs = { where: { id: string } };

type SecretUpdateWhere = {
  id: string;
  valueVersion?: number;
  storagePath?: string;
  valueCiphertext?: null | { not: null };
};

type SecretUpdateArgs = {
  where: SecretUpdateWhere;
  data: Partial<
    Pick<SecretRow, "storagePath" | "valueCiphertext" | "keyVersion">
  >;
};

describe("LegacySecretMigrationService", () => {
  let root: string;
  let storage: SecretStorageService;
  let rows: SecretRow[];
  let service: LegacySecretMigrationService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rp-v020-secret-migration-"));
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const config = {
      get: (key: string, fallback?: string) => {
        if (key === "RESOURCE_STORAGE_BASE_PATH") return root;
        if (key === "RESOURCE_ENCRYPTION_KEY") return encryptionKey;
        return fallback;
      },
    } as unknown as ConfigService;
    storage = new SecretStorageService(config, new EncryptionService(config));
    rows = [];

    const prisma = {
      secret: {
        findMany: ({ where, take }: SecretFindManyArgs) => {
          const excluded = new Set<string>(where.id?.notIn ?? []);
          return Promise.resolve(
            rows
              .filter((row) => row.storagePath !== null && !excluded.has(row.id))
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
              .slice(0, take),
          );
        },
        findUnique: ({ where }: SecretFindUniqueArgs) =>
          Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
        updateMany: ({ where, data }: SecretUpdateArgs) => {
          const row = rows.find((item) => {
            if (item.id !== where.id) return false;
            if (
              where.valueVersion !== undefined &&
              item.valueVersion !== where.valueVersion
            )
              return false;
            if (
              where.storagePath !== undefined &&
              item.storagePath !== where.storagePath
            )
              return false;
            if (where.valueCiphertext === null && item.valueCiphertext !== null)
              return false;
            if (
              where.valueCiphertext !== null &&
              typeof where.valueCiphertext === "object" &&
              where.valueCiphertext.not === null &&
              item.valueCiphertext === null
            )
              return false;
            return true;
          });
          if (!row) return Promise.resolve({ count: 0 });
          Object.assign(row, data);
          return Promise.resolve({ count: 1 });
        },
      },
    };
    service = new LegacySecretMigrationService(
      prisma as unknown as PrismaService,
      storage,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("makes PostgreSQL authoritative before removing a v0.1.x Secret file", async () => {
    const path = storage.path("tenant", "app", "legacy-api-key");
    await storage.replaceAtomically(path, Buffer.from("legacy-secret"), () => Promise.resolve());
    rows.push({
      id: "00000000-0000-0000-0000-000000000001",
      createdAt: new Date("2026-09-01T00:00:00Z"),
      valueVersion: 3,
      valueCiphertext: null,
      storagePath: path,
      keyVersion: 1,
    });

    const result = await service.migrateAll(10);

    expect(result).toEqual({ scanned: 1, migrated: 1, cleaned: 1, failed: 0 });
    expect(rows[0].storagePath).toBeNull();
    expect(rows[0].valueCiphertext).toBeTruthy();
    expect(storage.open(rows[0].valueCiphertext!)).toEqual(Buffer.from("legacy-secret"));
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes cleanup after a crash that already committed the DB payload", async () => {
    const path = storage.path("tenant", "app", "resume-me");
    await storage.replaceAtomically(path, Buffer.from("resume-secret"), () => Promise.resolve());
    const envelope = await storage.readLegacyEnvelope(path);
    rows.push({
      id: "00000000-0000-0000-0000-000000000002",
      createdAt: new Date("2026-09-01T00:00:00Z"),
      valueVersion: 1,
      valueCiphertext: envelope,
      storagePath: path,
      keyVersion: 1,
    });

    const result = await service.migrateAll(10);

    expect(result).toEqual({ scanned: 1, migrated: 0, cleaned: 1, failed: 0 });
    expect(rows[0].storagePath).toBeNull();
    expect(storage.open(rows[0].valueCiphertext!)).toEqual(Buffer.from("resume-secret"));
  });

  it("leaves a corrupt legacy Secret untouched and reports it for retry", async () => {
    const path = join(root, "corrupt-secret");
    await writeFile(path, "not-an-envelope", { mode: 0o600 });
    rows.push({
      id: "00000000-0000-0000-0000-000000000003",
      createdAt: new Date("2026-09-01T00:00:00Z"),
      valueVersion: 1,
      valueCiphertext: null,
      storagePath: path,
      keyVersion: 1,
    });

    const result = await service.migrateAll(10);

    expect(result).toEqual({ scanned: 1, migrated: 0, cleaned: 0, failed: 1 });
    expect(rows[0].valueCiphertext).toBeNull();
    expect(rows[0].storagePath).toBe(path);
    await expect(stat(path)).resolves.toBeDefined();
  });
});
