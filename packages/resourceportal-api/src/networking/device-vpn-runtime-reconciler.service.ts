import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { StackRuntimeService } from "../internal/stack-runtime.service";
import { StackSecretProvisionerService } from "../internal/stack-secret-provisioner.service";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import {
  deviceVpnPrivateSecretName,
  deviceVpnRuntimeTokenSecretName,
  deviceVpnStackName,
} from "./network-runtime-names";
import {
  deviceVpnStackDigest,
  renderDeviceVpnStack,
  type DeviceVpnStackNetwork,
} from "./device-vpn-stack";

type DockerResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

@Injectable()
export class DeviceVpnRuntimeReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly runtime: StackRuntimeService,
    private readonly secrets: StackSecretProvisionerService,
  ) {}

  async reconcile() {
    const gateway = await this.prisma.deviceVpnGateway.findUnique({
      where: { id: "primary" },
    });
    if (!gateway) {
      return {
        configured: false,
        devices: 0,
        networks: 0,
        deployed: false,
      };
    }

    const devices = await this.prisma.deviceVpnDevice.findMany({
      where: { revokedAt: null },
      orderBy: { createdAt: "asc" },
      include: {
        user: {
          select: {
            status: true,
            memberships: {
              where: { status: "Active" },
              select: { tenantId: true },
            },
          },
        },
        networks: {
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
    });

    const activeDevices = devices.filter(
      (device) =>
        device.user.status === "Active" &&
        device.user.memberships.some(
          (membership) => membership.tenantId === device.tenantId,
        ),
    );
    const activeDeviceIds = new Set(activeDevices.map((device) => device.id));
    const suspendedDeviceIds = devices
      .filter((device) => !activeDeviceIds.has(device.id))
      .map((device) => device.id);

    if (suspendedDeviceIds.length > 0) {
      await this.prisma.deviceVpnDevice.updateMany({
        where: { id: { in: suspendedDeviceIds }, revokedAt: null },
        data: {
          status: "Suspended",
          lastError: "Tenant membership or user account is not active",
        },
      });
    }

    if (activeDevices.length === 0) {
      await this.removeStack(deviceVpnStackName());
      await this.prisma.deviceVpnGateway.update({
        where: { id: gateway.id },
        data: { status: "Ready", lastError: null },
      });
      return {
        configured: true,
        devices: 0,
        networks: 0,
        deployed: false,
      };
    }

    try {
      const networkMap = new Map<string, DeviceVpnStackNetwork>();
      for (const device of activeDevices) {
        for (const link of device.networks) {
          if (!networkMap.has(link.network.id)) {
            networkMap.set(link.network.id, {
              id: link.network.id,
              swarmNetworkName: link.network.swarmNetworkName,
              overlayCidr: link.network.overlayCidr,
              attachments: link.network.attachments.map((attachment) => ({
                id: attachment.id,
                address: attachment.address,
              })),
            });
          }
        }
      }
      const networks = [...networkMap.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      );

      for (const network of networks) {
        const prepared = await this.runtime.reconcileTenantNetwork({
          networkName: network.swarmNetworkName,
          subnet: network.overlayCidr,
          networkId: network.id,
          tenantId:
            activeDevices
              .flatMap((device) => device.networks)
              .find((link) => link.network.id === network.id)?.network
              .tenantId ?? "",
        });
        if (!prepared.success) {
          throw new Error(
            "error" in prepared && prepared.error
              ? prepared.error
              : `Unable to prepare ${network.swarmNetworkName}`,
          );
        }
      }

      const privateSecretName = deviceVpnPrivateSecretName(
        gateway.keyVersion,
      );
      const runtimeTokenSecretName = deviceVpnRuntimeTokenSecretName(
        gateway.keyVersion,
      );
      const provisioned = await this.secrets.provisionSecrets([
        {
          dockerSecretName: privateSecretName,
          value: this.encryption.decrypt(gateway.privateKeyCiphertext),
        },
        {
          dockerSecretName: runtimeTokenSecretName,
          value: this.encryption.decrypt(gateway.runtimeTokenCiphertext),
        },
      ]);
      if (!provisioned.success) {
        throw new Error(provisioned.details || provisioned.message);
      }

      const input = {
        gatewayId: gateway.id,
        image: this.runtimeImage(),
        publishedPort: gateway.listenPort,
        serverTunnelAddress: gateway.serverTunnelAddress,
        privateSecretName,
        runtimeTokenSecretName,
        heartbeatUrl: this.heartbeatUrl(),
        peers: activeDevices.map((device) => ({
          deviceId: device.id,
          publicKey: device.publicKey,
          assignedAddress: device.assignedAddress,
          networkIds: device.networks.map((link) => link.networkId),
        })),
        networks,
      };
      const desiredDigest = deviceVpnStackDigest(input);
      const currentDigest = await this.currentDigest();
      const deployed =
        currentDigest === desiredDigest
          ? { exitCode: 0, stdout: "unchanged", stderr: "" }
          : await this.deployStack(
              deviceVpnStackName(),
              renderDeviceVpnStack(input),
            );
      if (deployed.exitCode !== 0) {
        throw new Error(
          deployed.stderr ||
            deployed.stdout ||
            "Unable to deploy Device VPN runtime",
        );
      }

      await this.prisma.$transaction([
        this.prisma.deviceVpnGateway.update({
          where: { id: gateway.id },
          data: { status: "Ready", lastError: null },
        }),
        this.prisma.deviceVpnDevice.updateMany({
          where: {
            id: { in: activeDevices.map((device) => device.id) },
            revokedAt: null,
          },
          data: { status: "Ready", lastError: null },
        }),
      ]);
      return {
        configured: true,
        devices: activeDevices.length,
        networks: networks.length,
        deployed: currentDigest !== desiredDigest,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      await this.prisma.$transaction([
        this.prisma.deviceVpnGateway.update({
          where: { id: gateway.id },
          data: {
            status: "Error",
            lastError: message.slice(0, 4000),
          },
        }),
        this.prisma.deviceVpnDevice.updateMany({
          where: {
            id: { in: activeDevices.map((device) => device.id) },
            revokedAt: null,
          },
          data: {
            status: "Error",
            lastError: message.slice(0, 4000),
          },
        }),
      ]);
      return {
        configured: true,
        devices: activeDevices.length,
        networks: 0,
        deployed: false,
        failed: true,
        error: message,
      };
    }
  }

  private runtimeImage() {
    const image =
      this.config.get<string>("RESOURCEPORTAL_RUNTIME_IMAGE") ??
      this.config.get<string>("RESOURCEPORTAL_API_IMAGE");
    if (!image) {
      throw new Error(
        "RESOURCEPORTAL_RUNTIME_IMAGE is required to deploy Device VPN",
      );
    }
    return image;
  }

  private heartbeatUrl() {
    const explicit = this.config.get<string>(
      "RESOURCEPORTAL_DEVICE_VPN_HEARTBEAT_URL",
    );
    if (explicit) return explicit;
    const base = this.config.get<string>("PUBLIC_API_URL");
    if (!base) {
      throw new Error(
        "PUBLIC_API_URL or RESOURCEPORTAL_DEVICE_VPN_HEARTBEAT_URL is required for Device VPN",
      );
    }
    return `${base.replace(/\/$/, "")}/api/networking/device-vpn/runtime/heartbeat`;
  }

  private async currentDigest() {
    const inspect = await this.runDocker([
      "service",
      "inspect",
      `${deviceVpnStackName()}_gateway`,
      "--format",
      '{{index .Spec.Labels "resourceportal.device-vpn.digest"}}',
    ]);
    if (inspect.exitCode !== 0) return null;
    return inspect.stdout.trim() || null;
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

  private async removeStack(stackName: string) {
    const result = await this.runDocker(["stack", "rm", stackName]);
    if (
      result.exitCode !== 0 &&
      !/nothing found|not found|does not exist/i.test(
        `${result.stderr} ${result.stdout}`,
      )
    ) {
      throw new Error(
        result.stderr ||
          result.stdout ||
          `Unable to remove stack ${stackName}`,
      );
    }
  }

  protected runDocker(args: string[], stdin?: string) {
    const dockerContext = this.config.get<string>("DOCKER_CONTEXT");
    const fullArgs = [
      ...(dockerContext ? ["--context", dockerContext] : []),
      ...args,
    ];
    const timeoutMs = Number.parseInt(
      this.config.get<string>(
        "DEVICE_VPN_RUNTIME_DOCKER_TIMEOUT_MS",
        "120000",
      ),
      10,
    );
    return new Promise<DockerResult>((resolve) => {
      const child = spawn("docker", fullArgs, {
        stdio: [
          stdin === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
        ],
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
        resolve({
          exitCode: 127,
          stdout: "",
          stderr: error.message,
        });
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
