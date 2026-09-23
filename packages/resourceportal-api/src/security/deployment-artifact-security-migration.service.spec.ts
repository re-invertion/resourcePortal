import { DeploymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "./encryption.service";
import { DeploymentArtifactSecurityMigrationService } from "./deployment-artifact-security-migration.service";

const encryption = {
  encrypt: vi.fn((value: string) => `enc:v1:protected:${Buffer.from(value).toString("base64url")}`),
} as unknown as EncryptionService;

describe("DeploymentArtifactSecurityMigrationService", () => {
  it("encrypts historical sensitive env values and removes persisted rendered plaintext", async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      appGroupDeployment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "deployment-1",
            status: DeploymentStatus.Succeeded,
            stackConfig: JSON.stringify({
              singleApps: [
                { environment: { POSTGRES_PASSWORD: "db-pass" }, variables: [] },
              ],
            }),
            renderedStack: "services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: db-pass\n",
          },
        ]),
        update,
      },
    } as unknown as PrismaService;

    const result = await new DeploymentArtifactSecurityMigrationService(
      prisma,
      encryption,
    ).migrateAll();

    expect(result).toMatchObject({ scanned: 1, migrated: 1, protectedValues: 1, failed: 0 });
    const call = update.mock.calls[0]?.[0] as unknown as {
      data: {
        stackConfig: string;
        renderedStack: null;
        renderedStackSha256: null;
      };
    };
    expect(call.data.stackConfig).not.toContain("db-pass");
    expect(call.data.stackConfig).toContain("enc:v1:");
    expect(call.data.renderedStack).toBeNull();
    expect(call.data.renderedStackSha256).toBeNull();
  });

  it("does not mutate active deployments", async () => {
    const update = vi.fn();
    const prisma = {
      appGroupDeployment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "deployment-active",
            status: DeploymentStatus.Deploying,
            stackConfig: JSON.stringify({ singleApps: [{ environment: { API_TOKEN: "token" } }] }),
            renderedStack: null,
          },
        ]),
        update,
      },
    } as unknown as PrismaService;

    const result = await new DeploymentArtifactSecurityMigrationService(
      prisma,
      encryption,
    ).migrateAll();
    expect(result.migrated).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
});
