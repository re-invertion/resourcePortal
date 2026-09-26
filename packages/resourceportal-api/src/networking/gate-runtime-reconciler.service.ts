import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { StackRuntimeService } from "../internal/stack-runtime.service";
import { StackSecretProvisionerService } from "../internal/stack-secret-provisioner.service";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import {
  gatePrivateSecretName,
  gateStackName,
} from "./network-runtime-names";
import { gateStackDigest, renderGateStack } from "./gate-stack";

type DockerResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

@Injectable()
export class GateRuntimeReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly runtime: StackRuntimeService,
    private readonly secrets: StackSecretProvisionerService,
  ) {}

  async reconcile() {
    const [gates, deletingNetworks] = await Promise.all([
      this.prisma.resourcePortalGate.findMany({
        include: {
          networks: {
            where: { enabled: true },
            orderBy: { createdAt: "asc" },
            include: {
              network: {
                include: {
                  attachments: { orderBy: { createdAt: "asc" } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.network.findMany({
        where: { status: "Deleting" },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    let ready = 0;
    let pending = 0;
    let removed = 0;
    let failed = 0;
    for (const gate of gates) {
      try {
        if (gate.revokedAt || gate.status === "Revoked" || gate.status === "Deleting") {
          await this.removeGateRuntime(gate.id, gate.serverKeyVersion);
          await this.prisma.resourcePortalGate.delete({
            where: { id: gate.id },
          });
          removed += 1;
          continue;
        }

        if (
          !gate.publicKey ||
          !gate.serverPrivateKeyCiphertext ||
          !gate.serverListenPort ||
          !gate.serverTunnelAddress ||
          !gate.clientTunnelAddress
        ) {
          await this.removeStack(gateStackName(gate.id));
          await this.prisma.resourcePortalGate.update({
            where: { id: gate.id },
            data: {
              status: "PendingEnrollment",
              lastError: null,
            },
          });
          pending += 1;
          continue;
        }

        if (gate.networks.length === 0) {
          await this.removeStack(gateStackName(gate.id));
          await this.prisma.resourcePortalGate.update({
            where: { id: gate.id },
            data: {
              status: "Ready",
              lastError: null,
            },
          });
          ready += 1;
          continue;
        }

        for (const link of gate.networks) {
          const prepared = await this.runtime.reconcileTenantNetwork({
            networkName: link.network.swarmNetworkName,
            subnet: link.network.overlayCidr,
            networkId: link.network.id,
            tenantId: gate.tenantId,
          });
          if (!prepared.success) {
            throw new Error(
              "error" in prepared && prepared.error
                ? prepared.error
                : `Unable to prepare ${link.network.swarmNetworkName}`,
            );
          }
          await this.prisma.network.update({
            where: { id: link.network.id },
            data: {
              status: "Ready",
              lastObservedAt: new Date(),
              lastError: null,
            },
          });
        }

        const secretName = gatePrivateSecretName(
          gate.id,
          gate.serverKeyVersion,
        );
        const provisioned = await this.secrets.provisionSecrets([
          {
            dockerSecretName: secretName,
            value: this.encryption.decrypt(gate.serverPrivateKeyCiphertext),
          },
        ]);
        if (!provisioned.success) {
          throw new Error(provisioned.details || provisioned.message);
        }

        const image = this.runtimeImage();
        const stackInput = {
          gateId: gate.id,
          image,
          publishedPort: gate.serverListenPort,
          serverTunnelAddress: gate.serverTunnelAddress,
          clientTunnelAddress: gate.clientTunnelAddress,
          peerPublicKey: gate.publicKey,
          peerLanCidrs: gate.lanCidrs,
          privateSecretName: secretName,
          networks: gate.networks.map((link) => ({
            id: link.network.id,
            swarmNetworkName: link.network.swarmNetworkName,
            overlayCidr: link.network.overlayCidr,
            attachments: link.network.attachments.map((attachment) => ({
              id: attachment.id,
              address: attachment.address,
            })),
          })),
        };
        const rendered = renderGateStack(stackInput);
        const desiredDigest = gateStackDigest(stackInput);
        const currentDigest = await this.currentGateDigest(gate.id);

        const deployed =
          currentDigest === desiredDigest
            ? { exitCode: 0, stdout: "unchanged", stderr: "" }
            : await this.deployStack(gateStackName(gate.id), rendered);
        if (deployed.exitCode !== 0) {
          throw new Error(
            deployed.stderr ||
              deployed.stdout ||
              `Unable to deploy Gate runtime ${gate.id}`,
          );
        }

        const observedAt = new Date();
        await this.prisma.$transaction([
          this.prisma.resourcePortalGate.update({
            where: { id: gate.id },
            data: {
              status: "Ready",
              lastError: null,
            },
          }),
          this.prisma.gateNetworkAttachment.updateMany({
            where: { gateId: gate.id, enabled: true },
            data: {
              status: "Ready",
              lastObservedAt: observedAt,
              lastError: null,
            },
          }),
        ]);
        ready += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        await this.prisma.$transaction([
          this.prisma.resourcePortalGate.update({
            where: { id: gate.id },
            data: { status: "Error", lastError: message.slice(0, 4000) },
          }),
          this.prisma.gateNetworkAttachment.updateMany({
            where: { gateId: gate.id, enabled: true },
            data: { status: "Error", lastError: message.slice(0, 4000) },
          }),
        ]);
      }
    }

    let networksDeleted = 0;
    let networkDeleteFailures = 0;
    for (const network of deletingNetworks) {
      const removedNetwork = await this.runtime.removeTenantNetwork(
        network.swarmNetworkName,
      );
      if (removedNetwork.success) {
        await this.prisma.network.delete({ where: { id: network.id } });
        networksDeleted += 1;
      } else {
        networkDeleteFailures += 1;
        await this.prisma.network.update({
          where: { id: network.id },
          data: {
            lastObservedAt: new Date(),
            lastError:
              ("error" in removedNetwork && removedNetwork.error
                ? removedNetwork.error
                : "Unable to remove tenant Network").slice(0, 4000),
          },
        });
      }
    }

    return {
      gates: gates.length,
      ready,
      pending,
      removed,
      failed,
      networksDeleting: deletingNetworks.length,
      networksDeleted,
      networkDeleteFailures,
    };
  }

  private async currentGateDigest(gateId: string) {
    const serviceName = `${gateStackName(gateId)}_gateway`;
    const inspect = await this.runDocker([
      "service",
      "inspect",
      serviceName,
      "--format",
      "{{index .Spec.Labels \"resourceportal.gate.digest\"}}",
    ]);
    if (inspect.exitCode !== 0) return null;
    const value = inspect.stdout.trim();
    return value || null;
  }

  private runtimeImage() {
    const image =
      this.config.get<string>("RESOURCEPORTAL_RUNTIME_IMAGE") ??
      this.config.get<string>("RESOURCEPORTAL_API_IMAGE");
    if (!image) {
      throw new Error(
        "RESOURCEPORTAL_RUNTIME_IMAGE is required to deploy ResourcePortalGate",
      );
    }
    return image;
  }

  private async removeGateRuntime(gateId: string, keyVersion: number) {
    await this.removeStack(gateStackName(gateId));
    const secretName = gatePrivateSecretName(gateId, keyVersion);
    const result = await this.runDocker(["secret", "rm", secretName]);
    if (
      result.exitCode !== 0 &&
      !/not found|no such secret|does not exist/i.test(
        `${result.stderr} ${result.stdout}`,
      )
    ) {
      throw new Error(
        result.stderr ||
          result.stdout ||
          `Unable to remove ResourcePortalGate secret ${secretName}`,
      );
    }
  }

  private async removeStack(stackName: string) {
    const result = await this.runDocker(["stack", "rm", stackName]);
    if (
      result.exitCode !== 0 &&
      !/nothing found|not found|does not exist/i.test(
        `${result.stderr} ${result.stdout}`,
      )
    ) {
      throw new Error(
        result.stderr || result.stdout || `Unable to remove stack ${stackName}`,
      );
    }
  }

  private deployStack(stackName: string, renderedStack: string) {
    return this.runDocker(
      [
        "stack",
        "deploy",
        "--detach=true",
        "--with-registry-auth",
        "-c",
        "-",
        stackName,
      ],
      renderedStack,
    );
  }

  protected runDocker(args: string[], stdin?: string) {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const fullArgs = [
      ...(dockerContext ? ["--context", dockerContext] : []),
      ...args,
    ];
    const timeoutMs = Number.parseInt(
      this.config.get<string>("GATE_RUNTIME_DOCKER_TIMEOUT_MS", "120000"),
      10,
    );
    return new Promise<DockerResult>((resolve) => {
      const child = spawn("docker", fullArgs, {
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) child.kill("SIGTERM");
      }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000);
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ exitCode: 127, stdout: "", stderr: error.message });
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          exitCode: signal ? 124 : (code ?? 1),
          stdout: Buffer.concat(stdout).toString("utf8").trim(),
          stderr: signal
            ? `docker command terminated by ${signal}`
            : Buffer.concat(stderr).toString("utf8").trim(),
        });
      });
      if (stdin !== undefined) child.stdin?.end(stdin);
    });
  }
}
