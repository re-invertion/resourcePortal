import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DeploymentPhase, DeploymentStatus, Prisma } from "@prisma/client";
import { stringify } from "yaml";
import { CapacityDeploymentAdmissionService } from "../capacity/capacity-deployment-admission.service";
import { PrismaService } from "../prisma/prisma.service";
import { mapAppGroupDeployment } from "../app-groups/app-groups.view";
import { getDockerImageHost } from "../registries/docker-image";
import { EncryptionService } from "../security/encryption.service";
import { SecretStorageService } from "../security/secret-storage.service";
import { AdvanceDeploymentDto } from "./dto/advance-deployment.dto";
import { FailDeploymentDto } from "./dto/fail-deployment.dto";
import { HeartbeatDeploymentDto } from "./dto/heartbeat-deployment.dto";
import {
  deploymentArtifactMatches,
  deploymentArtifactSha256,
} from "./deployment-artifact";
import { StackApplyService } from "./stack-apply.service";
import { StackConfigProvisionerService } from "./stack-config-provisioner.service";
import { StackRegistryAuthService } from "./stack-registry-auth.service";
import { StackRolloutService } from "./stack-rollout.service";
import { StackSecretProvisionerService } from "./stack-secret-provisioner.service";
import {
  renderRuntimeVolumeMount,
  storagePlacementConstraints,
} from "./stack-storage";
import { DEFAULT_VOLUME_RUNTIME_ROOT } from "../storage-backends/storage-paths";
import { appGroupNetworkName, renderTraefikLabels } from "./traefik-routing";
import { StackVolumeProvisionerService } from "./stack-volume-provisioner.service";

const DEFAULT_LEASE_SECONDS = 300;

const ALLOWED_PHASE_TRANSITIONS: Record<DeploymentPhase, DeploymentPhase[]> = {
  Validating: [DeploymentPhase.PreparingArtifacts],
  PreparingArtifacts: [DeploymentPhase.GeneratingStack],
  GeneratingStack: [DeploymentPhase.ApplyingStack],
  ApplyingStack: [DeploymentPhase.WaitingForRollout],
  WaitingForRollout: [DeploymentPhase.Cleanup, DeploymentPhase.Completed],
  RollingBack: [DeploymentPhase.Cleanup],
  Cleanup: [DeploymentPhase.Completed],
  Completed: [],
};

type StackConfigSnapshot = {
  appGroup: {
    id: string;
    tenantId: string;
    name: string;
    runtimeState: string;
    runtimeDraftRevision: number;
  };
  note?: string;
  singleApps: StackConfigSingleApp[];
};

type StackConfigSingleApp = {
  id: string;
  name: string;
  image: string;
  registryId: string | null;
  desiredReplicas: number;
  runtimeState: string;
  resources: {
    cpu: string;
    memoryBytes: string;
    gpu: number;
  };
  environment: Record<string, string>;
  variables: Array<{
    id: string;
    variableId: string;
    variableName: string;
    targetName: string;
    value: string;
  }>;
  secrets: Array<{
    id: string;
    attachmentId?: string;
    sourceType?: "AppGroup" | "LegacySingleApp";
    targetName?: string;
    name?: string;
    valueVersion: number;
    dockerSecretName?: string;
  }>;
  configs: Array<{
    id: string;
    configId: string;
    configName: string;
    contentVersion: number;
    targetPath: string;
    content: string;
    dockerConfigName?: string;
  }>;
  healthCheck: unknown;
  entrypoint: string | null;
  command: string[];
  workingDir: string | null;
  user: string | null;
  readOnlyRootFilesystem: boolean;
  stopGracePeriodSeconds: number;
  restartPolicy: Record<string, unknown>;
  updatePolicy: Record<string, unknown>;
  httpEndpoints: Array<{
    id: string;
    name: string;
    containerPort: number;
    protocolMode: string;
    domains: Array<{
      id: string;
      hostname: string;
      tlsEnabled: boolean;
      dnsStatus: string;
      certificateStatus: string;
    }>;
  }>;
  volumes: Array<{
    id: string;
    volumeId: string;
    volumeName: string;
    storagePath: string;
    dockerVolumeName?: string;
    mountPath: string;
    mode: "ReadOnly" | "ReadWrite";
  }>;
};

@Injectable()
export class DeploymentExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capacityAdmission: CapacityDeploymentAdmissionService,
    private readonly stackApplyService: StackApplyService,
    private readonly stackConfigProvisioner: StackConfigProvisionerService,
    private readonly stackRegistryAuth: StackRegistryAuthService,
    private readonly stackRolloutService: StackRolloutService,
    private readonly stackSecretProvisioner: StackSecretProvisionerService,
    private readonly stackVolumeProvisioner: StackVolumeProvisionerService,
    private readonly encryption: EncryptionService,
    private readonly secretStorage: SecretStorageService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async heartbeatDeployment(deploymentId: string, dto: HeartbeatDeploymentDto) {
    const deployment = await this.findWorkerDeploymentOrThrow(
      deploymentId,
      dto.workerId,
    );

    this.assertDeploymentIsActive(deployment.status);

    const updated = await this.prisma.appGroupDeployment.update({
      where: { id: deploymentId },
      data: {
        heartbeatAt: new Date(),
        leaseExpiresAt: this.calculateLeaseExpiration(dto.leaseSeconds),
      },
    });

    return mapAppGroupDeployment(updated);
  }

  async advanceDeployment(deploymentId: string, dto: AdvanceDeploymentDto) {
    const deployment = await this.findWorkerDeploymentOrThrow(
      deploymentId,
      dto.workerId,
    );

    this.assertDeploymentIsActive(deployment.status);
    this.assertPhaseTransition(deployment.phase, dto.phase);

    if (dto.phase === DeploymentPhase.PreparingArtifacts) {
      const validation = await this.validateDeploymentSnapshot(deployment);

      if (!validation.success) {
        return this.failDeploymentWithPhase(deployment.id, {
          phase: DeploymentPhase.Validating,
          errorCode: validation.errorCode,
          errorMessage: validation.message,
        });
      }

      const snapshot = this.parseStackConfig(deployment.stackConfig);
      const admission = await this.capacityAdmission.admitAndAdvance(
        deployment,
        snapshot,
        dto.message,
      );

      if (!admission.success) {
        return this.failDeploymentWithPhase(deployment.id, {
          phase: DeploymentPhase.Validating,
          errorCode: admission.errorCode,
          errorMessage: admission.message,
        });
      }

      return this.provisionArtifacts(admission.deployment.id, dto.workerId);
    }

    const completed = dto.phase === DeploymentPhase.Completed;
    const renderedStack =
      dto.phase === DeploymentPhase.GeneratingStack
        ? this.renderStack(deployment.stackConfig)
        : undefined;
    const renderedStackSha256 = renderedStack
      ? deploymentArtifactSha256(renderedStack)
      : undefined;
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.appGroupDeployment.update({
        where: { id: deploymentId },
        data: {
          phase: dto.phase,
          renderedStack,
          renderedStackSha256,
          renderedAt: renderedStack ? new Date() : undefined,
          status: completed
            ? DeploymentStatus.Succeeded
            : DeploymentStatus.Deploying,
          completedAt: completed ? new Date() : undefined,
          leaseOwner: completed ? null : deployment.leaseOwner,
          leaseExpiresAt: completed ? null : deployment.leaseExpiresAt,
          heartbeatAt: completed ? null : new Date(),
        },
      });

      await this.createDeploymentEvent(tx, deploymentId, {
        phase: dto.phase,
        level: "Info",
        message: dto.message ?? `Deployment advanced to ${dto.phase}`,
      });

      return next;
    });

    if (dto.phase === DeploymentPhase.ApplyingStack) {
      return this.applyRenderedStack(updated.id, dto.workerId);
    }

    if (dto.phase === DeploymentPhase.WaitingForRollout) {
      return this.waitForRollout(updated.id, dto.workerId);
    }

    return mapAppGroupDeployment(updated);
  }

  private async provisionArtifacts(deploymentId: string, workerId: string) {
    const deployment = await this.findWorkerDeploymentOrThrow(
      deploymentId,
      workerId,
    );
    const snapshot = this.parseStackConfig(deployment.stackConfig);

    const registryAuthResult = await this.provisionRegistryAuth(snapshot);

    if (!registryAuthResult.success) {
      return this.failProvisioning(
        deploymentId,
        "RegistryAuthFailed",
        registryAuthResult.message,
        registryAuthResult.details,
      );
    }

    const secretsResult = await this.provisionSecrets(snapshot);

    if (!secretsResult.success) {
      return this.failProvisioning(
        deploymentId,
        "SecretProvisioningFailed",
        secretsResult.message,
        secretsResult.details,
      );
    }

    const configsResult = await this.provisionConfigs(snapshot);

    if (!configsResult.success) {
      return this.failProvisioning(
        deploymentId,
        "ConfigProvisioningFailed",
        configsResult.message,
        configsResult.details,
      );
    }

    const volumes = snapshot.singleApps.flatMap((singleApp) =>
      singleApp.volumes.map((volume) => ({
        dockerVolumeName: volume.dockerVolumeName ?? volume.storagePath,
        storagePath: volume.storagePath,
      })),
    );

    if (volumes.length === 0) {
      return this.recordProvisioningSuccess(
        deploymentId,
        [
          registryAuthResult.message,
          registryAuthResult.details,
          secretsResult.message,
          secretsResult.details,
          configsResult.message,
          configsResult.details,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    const result = await this.stackVolumeProvisioner.provisionVolumes(volumes);

    if (!result.success) {
      return this.failProvisioning(
        deploymentId,
        "VolumeProvisioningFailed",
        result.message,
        result.details,
      );
    }

    return this.recordProvisioningSuccess(
      deploymentId,
      [
        secretsResult.message,
        secretsResult.details,
        registryAuthResult.message,
        registryAuthResult.details,
        result.message,
        result.details,
        configsResult.message,
        configsResult.details,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  private async provisionRegistryAuth(snapshot: StackConfigSnapshot) {
    const registryIds = Array.from(
      new Set(
        snapshot.singleApps
          .map((singleApp) => singleApp.registryId)
          .filter((registryId): registryId is string => registryId !== null),
      ),
    );

    if (registryIds.length === 0) {
      return {
        success: true,
        message: "Authenticated 0 registry(ies)",
        details: "",
      };
    }

    const registries = await this.prisma.registry.findMany({
      where: {
        id: { in: registryIds },
        tenantId: snapshot.appGroup.tenantId,
      },
      select: {
        id: true,
        host: true,
        authType: true,
        username: true,
        credentialData: true,
      },
    });
    const registriesById = new Map(
      registries.map((registry) => [registry.id, registry]),
    );
    const loginTargets = [];

    for (const registryId of registryIds) {
      const registry = registriesById.get(registryId);

      if (!registry) {
        return {
          success: false,
          message: `Registry ${registryId} is missing`,
          details: `Registry ${registryId} was not found for tenant ${snapshot.appGroup.tenantId}`,
        };
      }

      loginTargets.push({
        host: registry.host,
        authType: registry.authType,
        username: registry.username,
        credential: this.registryCredential(registry.credentialData),
      });
    }

    return this.stackRegistryAuth.login(loginTargets);
  }

  private async provisionSecrets(snapshot: StackConfigSnapshot) {
    const snapshotSecrets = snapshot.singleApps.flatMap((singleApp) =>
      singleApp.secrets.map((secret) => ({
        ...secret,
        dockerSecretName: this.secretName(secret.id, secret.valueVersion),
      })),
    );

    if (snapshotSecrets.length === 0) {
      return {
        success: true,
        message: "Provisioned 0 secret(s)",
        details: "",
      };
    }

    const appGroupSecretIds = snapshotSecrets
      .filter((secret) => secret.sourceType === "AppGroup")
      .map((secret) => secret.id);
    const legacySecretIds = snapshotSecrets
      .filter((secret) => secret.sourceType !== "AppGroup")
      .map((secret) => secret.id);
    const [appGroupSecrets, legacySecrets] = await Promise.all([
      this.prisma.secret.findMany({
        where: { id: { in: appGroupSecretIds } },
        select: {
          id: true,
          storagePath: true,
          valueCiphertext: true,
          keyVersion: true,
          valueVersion: true,
        },
      }),
      this.prisma.singleAppSecret.findMany({
        where: { id: { in: legacySecretIds } },
        select: { id: true, valueCiphertext: true, valueVersion: true },
      }),
    ]);
    const appGroupSecretsById = new Map(
      appGroupSecrets.map((secret) => [secret.id, secret]),
    );
    const legacySecretsById = new Map(
      legacySecrets.map((secret) => [secret.id, secret]),
    );
    const resolvedSecrets = [];

    for (const snapshotSecret of snapshotSecrets) {
      const displayName =
        snapshotSecret.targetName ?? snapshotSecret.name ?? snapshotSecret.id;

      if (snapshotSecret.sourceType === "AppGroup") {
        const databaseSecret = appGroupSecretsById.get(snapshotSecret.id);

        if (!databaseSecret) {
          return {
            success: false,
            message: `Secret ${displayName} is missing`,
            details: `Secret ${snapshotSecret.id} was not found`,
          };
        }

        if (databaseSecret.valueVersion !== snapshotSecret.valueVersion) {
          return {
            success: false,
            message: `Secret ${displayName} version mismatch`,
            details: `Expected version ${snapshotSecret.valueVersion}, found ${databaseSecret.valueVersion}`,
          };
        }

        try {
          const value = await this.resolveAppGroupSecretPayload(databaseSecret);
          resolvedSecrets.push({
            dockerSecretName: snapshotSecret.dockerSecretName,
            value,
          });
        } catch {
          return {
            success: false,
            message: `Secret ${displayName} payload is unavailable`,
            details: `Encrypted payload for Secret ${snapshotSecret.id} could not be read`,
          };
        }
        continue;
      }

      const databaseSecret = legacySecretsById.get(snapshotSecret.id);

      if (!databaseSecret) {
        return {
          success: false,
          message: `Secret ${displayName} is missing`,
          details: `SingleAppSecret ${snapshotSecret.id} was not found`,
        };
      }

      if (databaseSecret.valueVersion !== snapshotSecret.valueVersion) {
        return {
          success: false,
          message: `Secret ${displayName} version mismatch`,
          details: `Expected version ${snapshotSecret.valueVersion}, found ${databaseSecret.valueVersion}`,
        };
      }

      resolvedSecrets.push({
        dockerSecretName: snapshotSecret.dockerSecretName,
        value: this.encryption.decrypt(databaseSecret.valueCiphertext),
      });
    }

    return this.stackSecretProvisioner.provisionSecrets(resolvedSecrets);
  }

  private async resolveAppGroupSecretPayload(secret: {
    id: string;
    storagePath: string | null;
    valueCiphertext: string | null;
    keyVersion: number;
    valueVersion: number;
  }) {
    if (secret.valueCiphertext) {
      if (secret.keyVersion !== 1) {
        throw new Error(`Unsupported Secret key version ${secret.keyVersion}`);
      }
      return this.secretStorage.open(secret.valueCiphertext);
    }

    if (!secret.storagePath) {
      throw new Error(
        "Secret has neither database payload nor legacy storage path",
      );
    }

    // v0.1.x -> v0.2.0 compatibility: consume the old encrypted file once,
    // then persist the encrypted envelope in PostgreSQL. The legacy file may
    // remain on disk; it is no longer a source of truth after this commit.
    const plaintext = await this.secretStorage.readLegacy(secret.storagePath);
    const valueCiphertext = this.secretStorage.seal(plaintext);
    await this.prisma.secret.updateMany({
      where: {
        id: secret.id,
        valueVersion: secret.valueVersion,
        valueCiphertext: null,
      },
      data: {
        valueCiphertext,
        keyVersion: 1,
      },
    });
    return plaintext;
  }

  private provisionConfigs(snapshot: StackConfigSnapshot) {
    const configs = snapshot.singleApps.flatMap((singleApp) =>
      singleApp.configs.map((config) => ({
        dockerConfigName:
          config.dockerConfigName ??
          this.configName(config.configId, config.contentVersion),
        content: config.content,
      })),
    );

    if (configs.length === 0) {
      return {
        success: true,
        message: "Provisioned 0 config(s)",
        details: "",
      };
    }

    return this.stackConfigProvisioner.provisionConfigs(configs);
  }

  private registryCredential(credentialData: Prisma.JsonValue) {
    if (
      credentialData &&
      typeof credentialData === "object" &&
      !Array.isArray(credentialData) &&
      "valueCiphertext" in credentialData &&
      typeof credentialData.valueCiphertext === "string"
    ) {
      return this.encryption.decrypt(credentialData.valueCiphertext);
    }

    return null;
  }

  private async failProvisioning(
    deploymentId: string,
    errorCode: string,
    message: string,
    details: string,
  ) {
    const failed = await this.prisma.$transaction(async (tx) => {
      const next = await tx.appGroupDeployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.Failed,
          errorCode,
          errorMessage: this.truncate(details || message, 2000),
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      });

      await this.createDeploymentEvent(tx, deploymentId, {
        phase: DeploymentPhase.PreparingArtifacts,
        level: "Error",
        message: this.truncate(`${message}\n${details}`, 2000),
      });

      return next;
    });

    return mapAppGroupDeployment(failed);
  }

  private async recordProvisioningSuccess(
    deploymentId: string,
    message: string,
  ) {
    const provisioned = await this.prisma.$transaction(async (tx) => {
      const next = await tx.appGroupDeployment.update({
        where: { id: deploymentId },
        data: {
          heartbeatAt: new Date(),
        },
      });

      await this.createDeploymentEvent(tx, deploymentId, {
        phase: DeploymentPhase.PreparingArtifacts,
        level: "Info",
        message: this.truncate(
          message || "Provisioned deployment artifacts",
          2000,
        ),
      });

      return next;
    });

    return mapAppGroupDeployment(provisioned);
  }

  async failDeployment(deploymentId: string, dto: FailDeploymentDto) {
    const deployment = await this.findWorkerDeploymentOrThrow(
      deploymentId,
      dto.workerId,
    );

    this.assertDeploymentIsActive(deployment.status);

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.appGroupDeployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.Failed,
          errorCode: dto.errorCode,
          errorMessage: dto.errorMessage,
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      });

      await this.createDeploymentEvent(tx, deploymentId, {
        phase: deployment.phase,
        level: "Error",
        message: dto.errorMessage ?? dto.errorCode,
      });

      return next;
    });

    return mapAppGroupDeployment(updated);
  }

  private async findWorkerDeploymentOrThrow(
    deploymentId: string,
    workerId: string,
  ) {
    const deployment = await this.prisma.appGroupDeployment.findUnique({
      where: { id: deploymentId },
    });

    if (!deployment) {
      throw new NotFoundException("Deployment not found");
    }

    this.assertDeploymentIsActive(deployment.status);

    if (deployment.leaseOwner !== workerId) {
      throw new ConflictException("Deployment is leased by another worker");
    }

    return deployment;
  }

  private async validateDeploymentSnapshot(deployment: {
    appGroupId: string;
    stackConfig: string | null;
  }) {
    const snapshot = this.parseStackConfig(deployment.stackConfig);
    const appGroup = await this.prisma.appGroup.findUnique({
      where: { id: deployment.appGroupId },
      include: {
        tenant: {
          include: { quota: true },
        },
      },
    });

    if (!appGroup) {
      return this.validationFailure("AppGroupMissing", "App Group not found");
    }

    if (appGroup.status !== "Ready") {
      return this.validationFailure(
        "AppGroupNotReady",
        `App Group status is ${appGroup.status}`,
      );
    }

    if (appGroup.tenant.status !== "Active") {
      return this.validationFailure(
        "TenantNotActive",
        `Tenant status is ${appGroup.tenant.status}`,
      );
    }

    if (snapshot.singleApps.length === 0) {
      return this.validationFailure(
        "InvalidAppGroupConfiguration",
        "App Group has no deployable SingleApps",
      );
    }

    const gpuAllocation = snapshot.singleApps.find(
      (singleApp) => singleApp.resources.gpu > 0,
    );
    if (gpuAllocation) {
      return this.validationFailure(
        "GpuNotAvailable",
        `GPU allocation is not available for SingleApp ${gpuAllocation.name}`,
      );
    }

    const registryFailure = await this.validateRegistries(snapshot);
    if (registryFailure) {
      return registryFailure;
    }

    const volumeFailure = await this.validateVolumes(snapshot);
    if (volumeFailure) {
      return volumeFailure;
    }

    const domainFailure = this.validateDomains(snapshot);
    if (domainFailure) {
      return domainFailure;
    }

    const quotaFailure = this.validateQuota(snapshot, appGroup.tenant.quota);
    if (quotaFailure) {
      return quotaFailure;
    }

    return { success: true as const };
  }

  private async validateRegistries(snapshot: StackConfigSnapshot) {
    const registryIds = Array.from(
      new Set(
        snapshot.singleApps
          .map((singleApp) => singleApp.registryId)
          .filter((registryId): registryId is string => registryId !== null),
      ),
    );

    if (registryIds.length === 0) {
      return null;
    }

    const registries = await this.prisma.registry.findMany({
      where: {
        id: { in: registryIds },
        tenantId: snapshot.appGroup.tenantId,
      },
      select: {
        id: true,
        host: true,
        validationStatus: true,
      },
    });
    const registriesById = new Map(
      registries.map((registry) => [registry.id, registry]),
    );

    for (const singleApp of snapshot.singleApps) {
      if (!singleApp.registryId) {
        continue;
      }

      const registry = registriesById.get(singleApp.registryId);

      if (!registry) {
        return this.validationFailure(
          "RegistryUnavailable",
          `Registry ${singleApp.registryId} was not found`,
        );
      }

      if (registry.validationStatus !== "Valid") {
        return this.validationFailure(
          "RegistryUnavailable",
          `Registry ${registry.host} validation status is ${registry.validationStatus}`,
        );
      }

      const imageHost = getDockerImageHost(singleApp.image);
      if (registry.host !== imageHost) {
        return this.validationFailure(
          "RegistryMismatch",
          `Registry ${registry.host} does not match image host ${imageHost}`,
        );
      }
    }

    return null;
  }

  private async validateVolumes(snapshot: StackConfigSnapshot) {
    const volumeIds = Array.from(
      new Set(
        snapshot.singleApps.flatMap((singleApp) =>
          singleApp.volumes.map((volume) => volume.volumeId),
        ),
      ),
    );

    if (volumeIds.length === 0) {
      return null;
    }

    const volumes = await this.prisma.volume.findMany({
      where: {
        id: { in: volumeIds },
        tenantId: snapshot.appGroup.tenantId,
      },
      select: {
        id: true,
        name: true,
        status: true,
      },
    });
    const volumesById = new Map(volumes.map((volume) => [volume.id, volume]));

    for (const volumeId of volumeIds) {
      const volume = volumesById.get(volumeId);

      if (!volume) {
        return this.validationFailure(
          "VolumeUnavailable",
          `Volume ${volumeId} was not found`,
        );
      }

      if (volume.status !== "Ready") {
        return this.validationFailure(
          "VolumeUnavailable",
          `Volume ${volume.name} status is ${volume.status}`,
        );
      }
    }

    return null;
  }

  private validateDomains(snapshot: StackConfigSnapshot) {
    for (const singleApp of snapshot.singleApps) {
      for (const endpoint of singleApp.httpEndpoints) {
        if (endpoint.containerPort < 1 || endpoint.containerPort > 65535) {
          return this.validationFailure(
            "InvalidAppGroupConfiguration",
            `Endpoint ${endpoint.name} has invalid container port ${endpoint.containerPort}`,
          );
        }

        for (const domain of endpoint.domains) {
          if (domain.dnsStatus !== "Valid") {
            return this.validationFailure(
              "DomainUnavailable",
              `Domain ${domain.hostname} DNS status is ${domain.dnsStatus}`,
            );
          }

          if (domain.tlsEnabled && domain.certificateStatus === "Error") {
            return this.validationFailure(
              "DomainUnavailable",
              `Domain ${domain.hostname} certificate status is ${domain.certificateStatus}`,
            );
          }
        }
      }
    }

    return null;
  }

  private validateQuota(
    snapshot: StackConfigSnapshot,
    quota: {
      cpu: Prisma.Decimal;
      memoryBytes: bigint;
      gpu: number;
      storageBytes: bigint;
      maxSingleApps: number;
      maxVolumes: number;
    } | null,
  ) {
    if (!quota) {
      return null;
    }

    const requested = snapshot.singleApps.reduce(
      (acc, singleApp) => {
        const replicas = this.effectiveReplicas(snapshot, singleApp);

        return {
          cpu: acc.cpu + Number(singleApp.resources.cpu) * replicas,
          memoryBytes:
            acc.memoryBytes +
            Number(singleApp.resources.memoryBytes) * replicas,
          gpu: acc.gpu + singleApp.resources.gpu * replicas,
          singleApps: acc.singleApps + 1,
        };
      },
      { cpu: 0, memoryBytes: 0, gpu: 0, singleApps: 0 },
    );
    const volumeIds = new Set(
      snapshot.singleApps.flatMap((singleApp) =>
        singleApp.volumes.map((volume) => volume.volumeId),
      ),
    );

    if (requested.cpu > Number(quota.cpu)) {
      return this.validationFailure("QuotaExceeded", "CPU quota exceeded");
    }

    if (requested.memoryBytes > Number(quota.memoryBytes)) {
      return this.validationFailure("QuotaExceeded", "Memory quota exceeded");
    }

    if (requested.gpu > quota.gpu) {
      return this.validationFailure("QuotaExceeded", "GPU quota exceeded");
    }

    if (requested.singleApps > quota.maxSingleApps) {
      return this.validationFailure(
        "QuotaExceeded",
        "SingleApp quota exceeded",
      );
    }

    if (volumeIds.size > quota.maxVolumes) {
      return this.validationFailure("QuotaExceeded", "Volume quota exceeded");
    }

    return null;
  }

  private validationFailure(errorCode: string, message: string) {
    return {
      success: false as const,
      errorCode,
      message,
    };
  }

  private async failDeploymentWithPhase(
    deploymentId: string,
    failure: {
      phase: DeploymentPhase;
      errorCode: string;
      errorMessage: string;
    },
  ) {
    const failed = await this.prisma.$transaction(async (tx) => {
      const next = await tx.appGroupDeployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.Failed,
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      });

      await this.createDeploymentEvent(tx, deploymentId, {
        phase: failure.phase,
        level: "Error",
        message: failure.errorMessage,
      });

      return next;
    });

    return mapAppGroupDeployment(failed);
  }

  private assertDeploymentIsActive(status: DeploymentStatus) {
    if (status !== DeploymentStatus.Deploying) {
      throw new ConflictException(`Deployment is not active: ${status}`);
    }
  }

  private assertPhaseTransition(
    currentPhase: DeploymentPhase,
    nextPhase: DeploymentPhase,
  ) {
    const allowed = ALLOWED_PHASE_TRANSITIONS[currentPhase];

    if (!allowed.includes(nextPhase)) {
      throw new ConflictException(
        `Invalid deployment phase transition: ${currentPhase} -> ${nextPhase}`,
      );
    }
  }

  private calculateLeaseExpiration(leaseSeconds = DEFAULT_LEASE_SECONDS) {
    return new Date(Date.now() + leaseSeconds * 1000);
  }

  async ensureDeploymentArtifact(deploymentId: string) {
    const current = await this.prisma.appGroupDeployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        stackConfig: true,
        renderedStack: true,
        renderedStackSha256: true,
        renderedAt: true,
      },
    });
    if (!current) {
      throw new NotFoundException("Deployment was not found");
    }

    if (current.renderedStack) {
      const digest = deploymentArtifactSha256(current.renderedStack);
      if (
        current.renderedStackSha256 &&
        !deploymentArtifactMatches(
          current.renderedStack,
          current.renderedStackSha256,
        )
      ) {
        throw new ConflictException(
          "Persisted deployment artifact does not match its SHA-256 digest",
        );
      }

      if (!current.renderedStackSha256) {
        await this.prisma.appGroupDeployment.updateMany({
          where: {
            id: deploymentId,
            renderedStack: current.renderedStack,
            renderedStackSha256: null,
          },
          data: {
            renderedStackSha256: digest,
            renderedAt: current.renderedAt ?? new Date(),
          },
        });
      }

      const artifact = await this.prisma.appGroupDeployment.findUniqueOrThrow({
        where: { id: deploymentId },
        select: { renderedStack: true, renderedStackSha256: true },
      });
      if (
        !artifact.renderedStack ||
        !artifact.renderedStackSha256 ||
        !deploymentArtifactMatches(
          artifact.renderedStack,
          artifact.renderedStackSha256,
        )
      ) {
        throw new ConflictException(
          "Deployment artifact integrity could not be established",
        );
      }
      return {
        renderedStack: artifact.renderedStack,
        sha256: artifact.renderedStackSha256,
      };
    }

    if (!current.stackConfig) {
      throw new ConflictException(
        "Deployment has neither a rendered stack nor source stack config",
      );
    }

    // Supported v0.1.x deployments may predate persisted rendered artifacts.
    // Materialize exactly once, persist the bytes + digest, then every later
    // deploy/recovery/rollback reuses this immutable artifact.
    const renderedStack = this.renderStack(current.stackConfig);
    const sha256 = deploymentArtifactSha256(renderedStack);
    await this.prisma.appGroupDeployment.updateMany({
      where: { id: deploymentId, renderedStack: null },
      data: {
        renderedStack,
        renderedStackSha256: sha256,
        renderedAt: new Date(),
      },
    });

    const artifact = await this.prisma.appGroupDeployment.findUniqueOrThrow({
      where: { id: deploymentId },
      select: { renderedStack: true, renderedStackSha256: true },
    });
    if (
      !artifact.renderedStack ||
      !artifact.renderedStackSha256 ||
      !deploymentArtifactMatches(
        artifact.renderedStack,
        artifact.renderedStackSha256,
      )
    ) {
      throw new ConflictException(
        "Deployment artifact integrity could not be established",
      );
    }
    return {
      renderedStack: artifact.renderedStack,
      sha256: artifact.renderedStackSha256,
    };
  }

  private renderStack(stackConfig: string | null) {
    const snapshot = this.parseStackConfig(stackConfig);
    const stack = this.withoutUndefined({
      version: "3.9",
      services: Object.fromEntries(
        snapshot.singleApps.map((singleApp) => [
          this.serviceName(singleApp.name),
          this.renderService(snapshot, singleApp),
        ]),
      ),
      networks: this.renderNetworks(snapshot),
      secrets: this.renderSecrets(snapshot),
      configs: this.renderConfigs(snapshot),
    });

    return stringify(stack, { lineWidth: 0 });
  }

  private parseStackConfig(stackConfig: string | null) {
    if (!stackConfig) {
      throw new ConflictException("Deployment has no stack config");
    }

    return JSON.parse(stackConfig) as StackConfigSnapshot;
  }

  private async applyRenderedStack(deploymentId: string, workerId: string) {
    const deployment = await this.findWorkerDeploymentOrThrow(
      deploymentId,
      workerId,
    );

    const artifact = await this.ensureDeploymentArtifact(deployment.id);
    const stackName = this.stackName(deployment.appGroupId);
    const result = await this.stackApplyService.applyStack({
      stackName,
      renderedStack: artifact.renderedStack,
      artifactSha256: artifact.sha256,
      appGroupId: deployment.appGroupId,
    });

    if (result.exitCode !== 0) {
      const failed = await this.prisma.$transaction(async (tx) => {
        const next = await tx.appGroupDeployment.update({
          where: { id: deploymentId },
          data: {
            status: DeploymentStatus.Failed,
            errorCode: "DockerStackDeployFailed",
            errorMessage: this.truncate(
              result.stderr || result.stdout || `Exit code ${result.exitCode}`,
              2000,
            ),
            completedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
          },
        });

        await this.createDeploymentEvent(tx, deploymentId, {
          phase: DeploymentPhase.ApplyingStack,
          level: "Error",
          message: this.truncate(
            `${result.command}\n${result.stderr || result.stdout}`,
            2000,
          ),
        });

        return next;
      });

      return mapAppGroupDeployment(failed);
    }

    const applied = await this.prisma.$transaction(async (tx) => {
      const next = await tx.appGroupDeployment.update({
        where: { id: deploymentId },
        data: {
          heartbeatAt: new Date(),
        },
      });

      await this.createDeploymentEvent(tx, deploymentId, {
        phase: DeploymentPhase.ApplyingStack,
        level: "Info",
        message: this.truncate(
          `${result.command}\n${result.stdout || "Docker stack deploy succeeded"}`,
          2000,
        ),
      });

      return next;
    });

    return mapAppGroupDeployment(applied);
  }

  private async waitForRollout(deploymentId: string, workerId: string) {
    const deployment = await this.findWorkerDeploymentOrThrow(
      deploymentId,
      workerId,
    );
    const snapshot = this.parseStackConfig(deployment.stackConfig);
    const stackName = this.stackName(deployment.appGroupId);
    const result = await this.stackRolloutService.waitForRollout({
      stackName,
      expectedServices: snapshot.singleApps.map((singleApp) => ({
        name: `${stackName}_${this.serviceName(singleApp.name)}`,
        desiredReplicas: this.effectiveReplicas(snapshot, singleApp),
      })),
    });

    if (!result.success) {
      return this.rollbackAfterRuntimeFailure(
        deployment,
        snapshot,
        result.message,
        result.details,
      );
    }

    const completed = await this.prisma.$transaction(async (tx) => {
      const deletedSingleApps = await tx.singleApp.findMany({
        where: {
          appGroupId: deployment.appGroupId,
          pendingDeletion: true,
        },
        select: {
          id: true,
          name: true,
        },
      });

      if (deletedSingleApps.length > 0) {
        await tx.singleApp.deleteMany({
          where: {
            id: {
              in: deletedSingleApps.map((singleApp) => singleApp.id),
            },
          },
        });
      }

      const appGroup = await tx.appGroup.findUniqueOrThrow({
        where: { id: deployment.appGroupId },
        select: { runtimeDraftRevision: true },
      });
      const isExplicitRollback = deployment.rollbackTargetVersion !== null;
      const next = await tx.appGroupDeployment.update({
        where: { id: deploymentId },
        data: {
          phase: DeploymentPhase.Completed,
          status: isExplicitRollback
            ? DeploymentStatus.RolledBack
            : DeploymentStatus.Succeeded,
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      });

      await tx.appGroup.update({
        where: { id: deployment.appGroupId },
        data: {
          currentDeploymentVersion: isExplicitRollback
            ? deployment.rollbackTargetVersion
            : deployment.version,
          hasPendingChanges: isExplicitRollback
            ? true
            : appGroup.runtimeDraftRevision !== deployment.sourceDraftRevision,
        },
      });

      await this.createDeploymentEvent(tx, deploymentId, {
        phase: DeploymentPhase.Completed,
        level: "Info",
        message: this.truncate(
          isExplicitRollback
            ? `Rolled back to deployment v${deployment.rollbackTargetVersion}\n${result.message}\n${result.details}`
            : `${result.message}\n${result.details}`,
          2000,
        ),
      });

      if (deletedSingleApps.length > 0) {
        await this.createDeploymentEvent(tx, deploymentId, {
          phase: DeploymentPhase.Cleanup,
          level: "Info",
          message: `Deleted ${deletedSingleApps.length} pending single app(s): ${deletedSingleApps
            .map((singleApp) => singleApp.name)
            .join(", ")}`,
        });
      }

      return next;
    });

    return mapAppGroupDeployment(completed);
  }

  private async rollbackAfterRuntimeFailure(
    deployment: {
      id: string;
      appGroupId: string;
      version: number;
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
      stackConfig: string | null;
      sourceDraftRevision: number;
    },
    failedSnapshot: StackConfigSnapshot,
    message: string,
    details: string,
  ) {
    const rollbackTarget = await this.prisma.appGroupDeployment.findFirst({
      where: {
        appGroupId: deployment.appGroupId,
        status: DeploymentStatus.Succeeded,
        version: { lt: deployment.version },
      },
      orderBy: { version: "desc" },
    });

    if (!rollbackTarget?.stackConfig) {
      return this.failDeploymentWithPhase(deployment.id, {
        phase: DeploymentPhase.WaitingForRollout,
        errorCode: "RolloutFailed",
        errorMessage: this.truncate(`${message}\n${details}`, 2000),
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.appGroupDeployment.update({
        where: { id: deployment.id },
        data: {
          status: DeploymentStatus.RollingBack,
          phase: DeploymentPhase.RollingBack,
          rollbackTargetVersion: rollbackTarget.version,
          errorCode: "RolloutFailed",
          errorMessage: this.truncate(`${message}\n${details}`, 2000),
          heartbeatAt: new Date(),
        },
      });

      await this.createDeploymentEvent(tx, deployment.id, {
        phase: DeploymentPhase.WaitingForRollout,
        level: "Error",
        message: this.truncate(`${message}\n${details}`, 2000),
      });

      await this.createDeploymentEvent(tx, deployment.id, {
        phase: DeploymentPhase.RollingBack,
        level: "Info",
        message: `Rolling back to deployment v${rollbackTarget.version}`,
      });
    });

    const rollbackSnapshot = this.parseStackConfig(rollbackTarget.stackConfig);
    const stackName = this.stackName(deployment.appGroupId);
    const rollbackArtifact = await this.ensureDeploymentArtifact(
      rollbackTarget.id,
    );
    const applyResult = await this.stackApplyService.applyStack({
      stackName,
      renderedStack: rollbackArtifact.renderedStack,
      artifactSha256: rollbackArtifact.sha256,
      appGroupId: deployment.appGroupId,
    });

    if (applyResult.exitCode !== 0) {
      return this.markRollbackFailed(
        deployment.id,
        rollbackTarget.version,
        `Rollback stack deploy failed\n${applyResult.command}\n${
          applyResult.stderr ||
          applyResult.stdout ||
          `Exit code ${applyResult.exitCode}`
        }`,
      );
    }

    const rolloutResult = await this.stackRolloutService.waitForRollout({
      stackName,
      expectedServices: rollbackSnapshot.singleApps.map((singleApp) => ({
        name: `${stackName}_${this.serviceName(singleApp.name)}`,
        desiredReplicas: this.effectiveReplicas(rollbackSnapshot, singleApp),
      })),
    });

    if (!rolloutResult.success) {
      return this.markRollbackFailed(
        deployment.id,
        rollbackTarget.version,
        `${rolloutResult.message}\n${rolloutResult.details}`,
      );
    }

    const rolledBack = await this.prisma.$transaction(async (tx) => {
      const next = await tx.appGroupDeployment.update({
        where: { id: deployment.id },
        data: {
          status: DeploymentStatus.RolledBack,
          phase: DeploymentPhase.Completed,
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      });

      await tx.appGroup.update({
        where: { id: deployment.appGroupId },
        data: {
          currentDeploymentVersion: rollbackTarget.version,
          hasPendingChanges: true,
        },
      });

      await this.createDeploymentEvent(tx, deployment.id, {
        phase: DeploymentPhase.Completed,
        level: "Info",
        message: `Rolled back to deployment v${rollbackTarget.version}`,
      });

      return next;
    });

    return mapAppGroupDeployment(rolledBack);
  }

  private async markRollbackFailed(
    deploymentId: string,
    rollbackTargetVersion: number,
    message: string,
  ) {
    const failed = await this.prisma.$transaction(async (tx) => {
      const next = await tx.appGroupDeployment.update({
        where: { id: deploymentId },
        data: {
          status: DeploymentStatus.RollbackFailed,
          phase: DeploymentPhase.Completed,
          errorCode: "RollbackFailed",
          errorMessage: this.truncate(message, 2000),
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          appGroup: {
            update: {
              status: "Error",
              driftStatus: "Unknown",
            },
          },
        },
      });

      await this.createDeploymentEvent(tx, deploymentId, {
        phase: DeploymentPhase.Completed,
        level: "Error",
        message: this.truncate(
          `Rollback to deployment v${rollbackTargetVersion} failed\n${message}`,
          2000,
        ),
      });

      return next;
    });

    return mapAppGroupDeployment(failed);
  }

  private renderService(
    snapshot: StackConfigSnapshot,
    singleApp: StackConfigSingleApp,
  ) {
    const environment = this.renderEnvironment(singleApp);

    return this.withoutUndefined({
      image: singleApp.image,
      labels: {
        "resourceportal.workload": "tenant",
        "resourceportal.app-group-id": snapshot.appGroup.id,
        "resourceportal.tenant-id": snapshot.appGroup.tenantId,
      },
      environment: this.isEmptyRecord(environment) ? undefined : environment,
      command: singleApp.command.length > 0 ? singleApp.command : undefined,
      entrypoint: singleApp.entrypoint ?? undefined,
      working_dir: singleApp.workingDir ?? undefined,
      user: singleApp.user ?? undefined,
      read_only: singleApp.readOnlyRootFilesystem ? true : undefined,
      stop_grace_period: `${singleApp.stopGracePeriodSeconds}s`,
      healthcheck: this.renderHealthCheck(singleApp.healthCheck),
      networks: ["default"],
      volumes:
        singleApp.volumes.length > 0
          ? singleApp.volumes.map((volume) =>
              renderRuntimeVolumeMount({
                runtimeRoot:
                  this.config?.get<string>(
                    "RESOURCE_VOLUME_RUNTIME_ROOT",
                    DEFAULT_VOLUME_RUNTIME_ROOT,
                  ) ?? DEFAULT_VOLUME_RUNTIME_ROOT,
                tenantId: snapshot.appGroup.tenantId,
                volumeId: volume.volumeId,
                mountPath: volume.mountPath,
                mode: volume.mode,
              }),
            )
          : undefined,
      secrets:
        singleApp.secrets.length > 0
          ? singleApp.secrets.map((secret) => ({
              source: this.secretAlias(secret),
              target: secret.targetName ?? secret.name ?? secret.id,
            }))
          : undefined,
      configs:
        singleApp.configs.length > 0
          ? singleApp.configs.map((config) => ({
              source: this.configAlias(config),
              target: config.targetPath,
            }))
          : undefined,
      deploy: {
        replicas: this.effectiveReplicas(snapshot, singleApp),
        resources: {
          limits: {
            cpus: singleApp.resources.cpu,
            memory: `${singleApp.resources.memoryBytes}B`,
          },
        },
        restart_policy: this.renderRestartPolicy(singleApp.restartPolicy),
        update_config: this.renderUpdatePolicy(singleApp.updatePolicy),
        placement: {
          constraints: storagePlacementConstraints(
            singleApp.volumes.length > 0,
          ),
        },
        labels: this.renderTraefikLabels(snapshot, singleApp),
      },
    });
  }

  private renderRestartPolicy(policy: Record<string, unknown>) {
    return this.withoutUndefined({
      condition: policy.condition,
      delay: this.seconds(policy.delaySeconds),
      max_attempts: policy.maxAttempts,
      window: this.seconds(policy.windowSeconds),
    });
  }

  private renderUpdatePolicy(policy: Record<string, unknown>) {
    return this.withoutUndefined({
      parallelism: policy.parallelism,
      delay: this.seconds(policy.delaySeconds),
      order: policy.order,
      failure_action: "pause",
    });
  }

  private renderHealthCheck(healthCheck: unknown) {
    if (
      !healthCheck ||
      typeof healthCheck !== "object" ||
      Array.isArray(healthCheck)
    ) {
      return undefined;
    }

    const value = healthCheck as Record<string, unknown>;
    const command = value.command;

    if (typeof command !== "string" || command.trim().length === 0) {
      return undefined;
    }

    return this.withoutUndefined({
      test: ["CMD-SHELL", command],
      interval: this.seconds(value.intervalSeconds),
      timeout: this.seconds(value.timeoutSeconds),
      retries: typeof value.retries === "number" ? value.retries : undefined,
      start_period: this.seconds(value.startPeriodSeconds),
    });
  }

  private renderTraefikLabels(
    snapshot: StackConfigSnapshot,
    singleApp: StackConfigSingleApp,
  ) {
    return renderTraefikLabels(singleApp, {
      certResolver: this.config?.get<string>("TRAEFIK_CERT_RESOLVER"),
      swarmNetwork: appGroupNetworkName(snapshot.appGroup.id),
    });
  }

  private renderNetworks(snapshot: StackConfigSnapshot) {
    return {
      default: {
        external: true,
        name: appGroupNetworkName(snapshot.appGroup.id),
      },
    };
  }

  private renderSecrets(snapshot: StackConfigSnapshot) {
    const secrets = new Map<string, { external: true; name: string }>();

    for (const singleApp of snapshot.singleApps) {
      for (const secret of singleApp.secrets) {
        secrets.set(this.secretAlias(secret), {
          external: true,
          name:
            secret.dockerSecretName ??
            this.secretName(secret.id, secret.valueVersion),
        });
      }
    }

    return secrets.size > 0 ? Object.fromEntries(secrets) : undefined;
  }

  private renderConfigs(snapshot: StackConfigSnapshot) {
    const configs = new Map<string, { external: true; name: string }>();

    for (const singleApp of snapshot.singleApps) {
      for (const config of singleApp.configs) {
        configs.set(this.configAlias(config), {
          external: true,
          name:
            config.dockerConfigName ??
            this.configName(config.configId, config.contentVersion),
        });
      }
    }

    return configs.size > 0 ? Object.fromEntries(configs) : undefined;
  }

  private renderEnvironment(singleApp: StackConfigSingleApp) {
    return {
      ...Object.fromEntries(
        singleApp.variables.map((variable) => [
          variable.targetName,
          variable.value,
        ]),
      ),
      ...singleApp.environment,
    };
  }

  private effectiveReplicas(
    snapshot: StackConfigSnapshot,
    singleApp: StackConfigSingleApp,
  ) {
    if (
      snapshot.appGroup.runtimeState !== "Running" ||
      singleApp.runtimeState !== "Running"
    ) {
      return 0;
    }

    return singleApp.desiredReplicas;
  }

  private seconds(value: unknown) {
    return typeof value === "number" ? `${value}s` : undefined;
  }

  private serviceName(name: string) {
    return name.replaceAll("-", "_");
  }

  private volumeName(name: string) {
    return `rp_${name.replaceAll("-", "_")}`;
  }

  private secretAlias(secret: { id: string; valueVersion: number }) {
    return this.secretName(secret.id, secret.valueVersion);
  }

  private secretName(secretId: string, valueVersion: number) {
    return `rp_secret_${secretId.replaceAll("-", "_")}_v${valueVersion}`;
  }

  private configAlias(config: { configId: string; contentVersion: number }) {
    return this.configName(config.configId, config.contentVersion);
  }

  private configName(configId: string, contentVersion: number) {
    return `rp_config_${configId.replaceAll("-", "_")}_v${contentVersion}`;
  }

  private stackName(appGroupId: string) {
    return `rp_${appGroupId.replaceAll("-", "_")}`;
  }

  private truncate(value: string, maxLength: number) {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private isEmptyRecord(value: Record<string, unknown>) {
    return Object.keys(value).length === 0;
  }

  private withoutUndefined<T extends Record<string, unknown>>(value: T) {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
    );
  }

  private createDeploymentEvent(
    tx: Prisma.TransactionClient,
    deploymentId: string,
    event: {
      phase: DeploymentPhase;
      level: "Info" | "Warning" | "Error";
      message: string;
    },
  ) {
    return tx.deploymentEvent.create({
      data: {
        deploymentId,
        phase: event.phase,
        level: event.level,
        message: event.message,
      },
    });
  }
}
