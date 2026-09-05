import { readFile } from "node:fs/promises";
import { StorageBackendStatus, StorageBackendType } from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("Stage 14 Prisma storage backend contract", () => {
  it("generates the LocalFilesystem backend type and lifecycle status enums", () => {
    expect(StorageBackendType.LocalFilesystem).toBe("LocalFilesystem");
    expect(StorageBackendStatus.Ready).toBe("Ready");
    expect(StorageBackendStatus.Error).toBe("Error");
  });

  it("declares Wiki-approved StorageBackend defaults in Prisma schema", async () => {
    const schema = await readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    expect(schema).toContain('basePath            String               @default("/srv/resource-portal/storage")');
    expect(schema).toContain('volumeBasePath      String               @default("/srv/resource-portal/storage/volumes")');
    expect(schema).toContain('secretBasePath      String               @default("/srv/resource-portal/storage/secrets")');
  });
});
