import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { InstallerEnrollmentNodeLabelService } from "../../internal/installer-enrollment-node-label.service";
import { StorageCommandRunnerService } from "../../storage-backends/storage-command-runner.service";
import type { OperationExecutor } from "../operation-executor";
import type { OperationRecord, OperationType } from "../operation.types";

type EnrollmentInput = {
  role?: unknown;
  publicKey?: unknown;
  nodeId?: unknown;
  controlPlane?: unknown;
  ingress?: unknown;
};

@Injectable()
export class InstallerEnrollmentOperationExecutor implements OperationExecutor {
  readonly types = [
    "INSTALLER_ENROLLMENT_PREPARE",
    "INSTALLER_ENROLLMENT_COMPLETE",
  ] as const satisfies readonly OperationType[];

  constructor(
    private readonly runner: StorageCommandRunnerService,
    private readonly labels: InstallerEnrollmentNodeLabelService,
    private readonly config: ConfigService,
  ) {}

  async execute(operation: OperationRecord) {
    const input = this.input(operation);
    const role = this.role(input.role);

    if (operation.type === "INSTALLER_ENROLLMENT_PREPARE") {
      const publicKey = this.publicKey(input.publicKey);
      const token = await this.joinToken(role);
      const encryptedJoinToken = publicEncrypt(
        {
          key: publicKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(token, "utf8"),
      ).toString("base64");

      return {
        resourceId: operation.resourceId,
        result: {
          encryptedJoinToken,
          managerEndpoint: this.required("INSTALLER_SWARM_MANAGER_ENDPOINT"),
          nfsServerAddress: this.required("INSTALLER_STORAGE_SERVER_ADDRESS"),
          clusterId: await this.clusterId(),
          installerVersion: this.required("INSTALLER_VERSION"),
          swarmAdvertiseAddr: this.required("INSTALLER_SWARM_ADVERTISE_ADDR"),
          clusterCidr: this.required("INSTALLER_CLUSTER_CIDR"),
        },
      };
    }

    const nodeId = this.string(input.nodeId, "nodeId");
    const controlPlane = this.boolean(input.controlPlane, false);
    const ingress = this.boolean(input.ingress, false);
    await this.labels.apply(nodeId, role, controlPlane, ingress);
    return {
      resourceId: operation.resourceId,
      result: { nodeId, role, controlPlane, ingress },
    };
  }

  private async joinToken(role: "worker" | "manager") {
    const result = await this.runner.run("docker", ["swarm", "join-token", "-q", role]);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw Object.assign(new Error(result.stderr || "Unable to read Swarm join token"), {
        code: "SwarmJoinTokenUnavailable",
        retryable: true,
      });
    }
    return result.stdout.trim();
  }

  private async clusterId() {
    const result = await this.runner.run("docker", [
      "info",
      "--format",
      "{{.Swarm.Cluster.ID}}",
    ]);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw Object.assign(new Error(result.stderr || "Unable to inspect Swarm cluster"), {
        code: "SwarmClusterUnavailable",
        retryable: true,
      });
    }
    return result.stdout.trim();
  }

  private input(operation: OperationRecord): EnrollmentInput {
    if (!isRecord(operation.input)) {
      throw new Error("InvalidOperationInput");
    }
    return {
      role: operation.input.role,
      publicKey: operation.input.publicKey,
      nodeId: operation.input.nodeId,
      controlPlane: operation.input.controlPlane,
      ingress: operation.input.ingress,
    };
  }

  private role(value: unknown): "worker" | "manager" {
    if (value !== "worker" && value !== "manager") throw new Error("InvalidEnrollmentRole");
    return value;
  }

  private publicKey(value: unknown) {
    const pem = this.string(value, "publicKey");
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "rsa") throw new Error("InvalidEnrollmentPublicKey");
    return key;
  }

  private string(value: unknown, field: string) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`InvalidOperationInput:${field}`);
    }
    return value;
  }

  private boolean(value: unknown, fallback: boolean) {
    return typeof value === "boolean" ? value : fallback;
  }

  private required(key: string) {
    const value = this.config.get<string>(key);
    if (!value) throw new Error(`Missing worker enrollment configuration: ${key}`);
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
