import { normalizeSwarmCapabilityAdd } from "./swarm-capabilities";
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
          remoteLanAttachments: {
            where: { status: { in: ["Provisioning", "Active"] } },
            include: {
              network: true,
              singleApp: { include: { appGroup: { select: { tenantId: true } } } },
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
    // Tenant Networks remain independent of LAN Attachments.
    const pendingNetworks = await this.prisma.network.findMany({
      where: { status: { in: ["Provisioning", "Error"] } },
      orderBy: { createdAt: "asc" },
    });
    for (const network of pendingNetworks) {
      try {
        const result = await this.runtime.reconcileTenantNetwork({
          networkName: network.swarmNetworkName,
          subnet: network.overlayCidr,
          networkId: network.id,
          tenantId: network.tenantId,
        });
        await this.prisma.network.update({
          where: { id: network.id },
          data: result.success
            ? { status: "Ready", lastObservedAt: new Date(), lastError: null }
            : { status: "Error", lastError: ("error" in result ? String(result.error) : "Network provision failed").slice(0, 1024) },
        });
      } catch (error) {
        await this.prisma.network.update({
          where: { id: network.id },
          data: { status: "Error", lastError: String(error instanceof Error ? error.message : error).slice(0, 1024) },
        });
      }
    }

    for (const gate of gates) {
      try {
        const attachments = gate.remoteLanAttachments;
        if (gate.revokedAt || gate.status === "Revoked" || gate.status === "Deleting") {
          await this.removeGateRuntime(gate.id, gate.serverKeyVersion);
          await this.prisma.resourcePortalGate.delete({ where: { id: gate.id } });
          removed += 1;
          continue;
        }
        if (!gate.publicKey || !gate.serverPrivateKeyCiphertext ||
            !gate.serverListenPort || !gate.serverTunnelAddress ||
            !gate.clientTunnelAddress || !["gate-l2-v1","gate-l2-v2"].includes(gate.agentVersion ?? "")) {
          // A legacy Gate must NEVER receive any L2 grant. Remove the
          // previous stack/route surface before requiring re-enrollment.
          await this.removeStack(gateStackName(gate.id));
          await this.prisma.resourcePortalGate.update({
            where: { id: gate.id },
            data: { status: "PendingEnrollment", lastError: null },
          });
          pending += 1;
          continue;
        }
        if (!attachments.length) {
          await this.removeStack(gateStackName(gate.id));
          await this.prisma.resourcePortalGate.update({
            where: { id: gate.id }, data: { status: "Ready", lastError: null },
          });
          ready += 1;
          continue;
        }
        const networks = new Map<string, {
          id: string; swarmNetworkName: string; overlayCidr: string;
        }>();
        for (const attachment of attachments) {
          if (attachment.gateId !== gate.id || attachment.tenantId !== gate.tenantId ||
              attachment.network.tenantId !== gate.tenantId ||
              attachment.singleApp.appGroup.tenantId !== gate.tenantId ||
              attachment.singleApp.pendingDeletion || attachment.singleApp.desiredReplicas !== 1)
            throw new Error("Untrusted or revoked Remote LAN tenant application");
          networks.set(attachment.networkId, {
            id: attachment.network.id,
            swarmNetworkName: attachment.network.swarmNetworkName,
            overlayCidr: attachment.network.overlayCidr,
          });
        }
        for (const network of networks.values()) {
          const provisioned = await this.runtime.reconcileTenantNetwork({
            networkName: network.swarmNetworkName, subnet: network.overlayCidr,
            networkId: network.id, tenantId: gate.tenantId,
          });
          if (!provisioned.success)
            throw new Error("Unable to prepare Remote LAN tenant overlay: " +
              ("error" in provisioned ? String(provisioned.error) : "unknown"));
          await this.prisma.network.update({
            where: { id: network.id },
            data: { status: "Ready", lastObservedAt: new Date(), lastError: null },
          });
        }
        const secretName = gatePrivateSecretName(gate.id, gate.serverKeyVersion);
        const secret = await this.secrets.provisionSecrets([{
          dockerSecretName: secretName,
          value: this.encryption.decrypt(gate.serverPrivateKeyCiphertext),
        }]);
        if (!secret.success) throw new Error(secret.details || secret.message);
        const stackInput = {
          gateId: gate.id, image: this.runtimeImage(), publishedPort: gate.serverListenPort,
          serverTunnelAddress: gate.serverTunnelAddress,
          clientTunnelAddress: gate.clientTunnelAddress,
          peerPublicKey: gate.publicKey,
          privateSecretName: secretName,
          remoteLanAttachments: attachments.map(attachment => ({
            attachmentId: attachment.id,
            tenantId: attachment.tenantId,
            singleAppId: attachment.singleAppId,
            gateId: gate.id, networkId: attachment.networkId,
            overlayCidr: attachment.network.overlayCidr,
            serviceName: "rp_" + attachment.singleApp.appGroupId.replaceAll("-", "_") +
              "_" + attachment.singleApp.name.replaceAll("-", "_"),
            macAddress: attachment.macAddress,
          })),
          networks: [...networks.values()].map(network => ({
            ...network, attachments: [] as Array<{ id: string; address: string }>,
          })),
        };
        const digest = gateStackDigest(stackInput);
        if (await this.currentGateDigest(gate.id) !== digest) {
          const deployed = await this.deployStack(gateStackName(gate.id),
            renderGateStack(stackInput));
          if (deployed.exitCode !== 0)
            throw new Error(deployed.stderr || deployed.stdout ||
              "Unable to deploy Remote LAN Gateway runtime");
        }
        await this.ensureGatewayCapabilities(gate.id);
        await this.prisma.resourcePortalGate.update({
          where: { id: gate.id }, data: { status: "Ready", lastError: null },
        });
        ready += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        await this.prisma.resourcePortalGate.update({
          where: { id: gate.id },
          data: { status: "Error", lastError: message.slice(0, 4000) },
        });
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

  private async ensureGatewayCapabilities(gateId: string) {
    const name = `${gateStackName(gateId)}_gateway`;
    const required = ["NET_ADMIN", "NET_RAW"];
    const inspectArgs = [
      "service", "inspect", name,
      "--format", "{{json .Spec.TaskTemplate.ContainerSpec.CapabilityAdd}}",
    ];
    const before = await this.runDocker(inspectArgs);
    if (before.exitCode !== 0) {
      throw new Error(`Cannot inspect Site VPN gateway capabilities: ${before.stderr}`);
    }
    let enabled: unknown;
    try {
      enabled = JSON.parse(before.stdout || "null") as unknown;
    } catch {
      throw new Error("Malformed Site VPN gateway capability inspection");
    }
    const current = normalizeSwarmCapabilityAdd(enabled);
    const missing = required.filter(cap => !current.includes(cap));
    // Docker Swarm owns namespace sysctls; the container's /proc/sys is RO.
    const inspectSysctl = ["service","inspect",name,"--format",
      "{{json .Spec.TaskTemplate.ContainerSpec.Sysctls}}"];
    const beforeSysctl = await this.runDocker(inspectSysctl);
    if (beforeSysctl.exitCode !== 0)
      throw new Error("Cannot inspect Gate Swarm sysctls: "+beforeSysctl.stderr);
    let currentSysctls: unknown;
    try { currentSysctls=JSON.parse(beforeSysctl.stdout||"null") as unknown; }
    catch { throw new Error("Malformed Gate Swarm sysctl inspection"); }
    if (currentSysctls!==null && (typeof currentSysctls!=="object" ||
        Array.isArray(currentSysctls)))
      throw new Error("Untrusted Gate Swarm sysctl policy");
    const entries=(currentSysctls??{}) as Record<string,unknown>;
    if (entries["net.ipv4.ip_forward"]!==undefined &&
        entries["net.ipv4.ip_forward"]!=="0")
      throw new Error("Gate Swarm sysctl requests enabled IPv4 forwarding");
    const missingSysctl=entries["net.ipv4.ip_forward"]!=="0";
    if (missing.length === 0 && !missingSysctl) return;
    const update = await this.runDocker([
      "service", "update", "--detach=false",
      ...missing.flatMap(cap => ["--cap-add", cap]),
      ...(missingSysctl ? ["--sysctl-add","net.ipv4.ip_forward=0"] : []), name,
    ]);
    if (update.exitCode !== 0) {
      throw new Error(`Cannot grant Site VPN gateway capabilities: ${update.stderr || update.stdout}`);
    }
    const after = await this.runDocker(inspectArgs);
    if (after.exitCode !== 0) throw new Error("Cannot verify Site VPN gateway capabilities");
    let actual: unknown;
    try {
      actual = JSON.parse(after.stdout || "null") as unknown;
    } catch {
      throw new Error("Malformed Site VPN gateway capability verification");
    }
    const verified = normalizeSwarmCapabilityAdd(actual);
    const afterSysctl=await this.runDocker(inspectSysctl);
    if (afterSysctl.exitCode!==0)
      throw new Error("Cannot verify Gate Swarm sysctls");
    let verifiedSysctl: unknown;
    try { verifiedSysctl=JSON.parse(afterSysctl.stdout||"null") as unknown; }
    catch { throw new Error("Malformed Gate Swarm sysctl verification"); }
    if(!verifiedSysctl || typeof verifiedSysctl!=="object" ||
       Array.isArray(verifiedSysctl) ||
       (verifiedSysctl as Record<string,unknown>)["net.ipv4.ip_forward"]!=="0")
      throw new Error("Gate Swarm sysctl IPv4 forwarding must remain disabled");
    if (!required.every(cap => verified.includes(cap))) {
      throw new Error("Site VPN gateway capabilities were not applied to Swarm service");
    }
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