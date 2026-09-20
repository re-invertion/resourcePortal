import { ConfigService } from "@nestjs/config";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InstallerEnrollmentNodeLabelService } from "../../internal/installer-enrollment-node-label.service";
import { StorageCommandRunnerService } from "../../storage-backends/storage-command-runner.service";
import { InstallerEnrollmentOperationExecutor } from "./installer-enrollment-operation.executor";

function operation(type: string, input: Record<string, unknown>) {
  return {
    id: "10000000-0000-0000-0000-000000000001",
    type,
    tenantId: null,
    resourceType: "InstallerEnrollment",
    resourceId: "20000000-0000-0000-0000-000000000001",
    input,
  } as never;
}

describe("InstallerEnrollmentOperationExecutor", () => {
  it("reads the join token only in the Worker and persists only RSA ciphertext", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const joinToken = "SWMTKN-1-worker-secret-that-must-never-be-persisted";
    const runner = {
      run: vi.fn((_command: string, args: string[]) => {
        if (args[0] === "swarm") {
          return Promise.resolve({ exitCode: 0, stdout: joinToken, stderr: "", command: "docker" });
        }
        return Promise.resolve({ exitCode: 0, stdout: "cluster-abc", stderr: "", command: "docker" });
      }),
    } as unknown as StorageCommandRunnerService;
    const config = {
      get: (key: string) =>
        ({
          INSTALLER_SWARM_MANAGER_ENDPOINT: "10.20.0.10:2377",
          INSTALLER_STORAGE_SERVER_ADDRESS: "10.20.0.10",
          INSTALLER_VERSION: "0.2.0",
          INSTALLER_SWARM_ADVERTISE_ADDR: "10.20.0.10",
          INSTALLER_CLUSTER_CIDR: "10.20.0.0/24",
        })[key],
    } as ConfigService;
    const executor = new InstallerEnrollmentOperationExecutor(
      runner,
      { apply: vi.fn() } as unknown as InstallerEnrollmentNodeLabelService,
      config,
    );

    const result = await executor.execute(
      operation("INSTALLER_ENROLLMENT_PREPARE", { role: "worker", publicKey }),
    );
    const payload = result.result as { encryptedJoinToken: string };
    expect(JSON.stringify(result)).not.toContain(joinToken);
    expect(
      privateDecrypt(
        {
          key: privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(payload.encryptedJoinToken, "base64"),
      ).toString("utf8"),
    ).toBe(joinToken);
  });

  it("applies node labels only from the Worker completion operation", async () => {
    const labels = { apply: vi.fn().mockResolvedValue(undefined) };
    const executor = new InstallerEnrollmentOperationExecutor(
      { run: vi.fn() } as unknown as StorageCommandRunnerService,
      labels as unknown as InstallerEnrollmentNodeLabelService,
      { get: vi.fn() } as unknown as ConfigService,
    );

    await executor.execute(
      operation("INSTALLER_ENROLLMENT_COMPLETE", {
        role: "manager",
        nodeId: "abcdefghijklmnopqrstuvwxy",
        controlPlane: true,
        ingress: false,
      }),
    );

    expect(labels.apply).toHaveBeenCalledWith(
      "abcdefghijklmnopqrstuvwxy",
      "manager",
      true,
      false,
    );
  });
});
