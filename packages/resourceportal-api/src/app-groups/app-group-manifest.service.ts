import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { RegistriesService } from "../registries/registries.service";
import { SecretStorageService } from "../security/secret-storage.service";
import { DEFAULT_RESTART_POLICY, DEFAULT_UPDATE_POLICY } from "./default-policies";
import {
  AppGroupManifest,
  ManifestIssue,
  parseAppGroupManifest,
  redactedManifestPreview,
} from "./app-group-manifest";

type ManifestSummary = {
  appGroupName: string;
  runtimeState: "Running" | "Stopped";
  apps: number;
  variables: number;
  secrets: number;
  configs: number;
  httpEndpoints: number;
  domainAttachments: number;
  volumeAttachments: number;
  registries: string[];
  volumes: string[];
  domains: string[];
  requiredPermissions: string[];
};

type ValidationResult = {
  valid: boolean;
  errors: ManifestIssue[];
  warnings: ManifestIssue[];
  summary?: ManifestSummary;
  preview?: ReturnType<typeof redactedManifestPreview>;
};

type ExternalResources = {
  registries: Map<string, { id: string; name: string }>;
  volumes: Map<string, { id: string; name: string }>;
  domains: Map<string, { id: string; hostname: string; httpEndpointId: string | null }>;
};

@Injectable()
export class AppGroupManifestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registriesService: RegistriesService,
    private readonly secretStorage: SecretStorageService,
  ) {}

  async validateManifest(
    tenantId: string,
    source: string,
    permissions: string[],
  ): Promise<ValidationResult> {
    const parsed = parseAppGroupManifest(source);
    if (!parsed.manifest) {
      return { valid: false, errors: parsed.errors, warnings: [] };
    }

    const manifest = parsed.manifest;
    const errors = [...parsed.errors];
    const warnings: ManifestIssue[] = [];
    const requiredPermissions = this.requiredPermissions(manifest);

    if (!permissions.includes("*")) {
      for (const permission of requiredPermissions) {
        if (!permissions.includes(permission)) {
          errors.push({
            path: "$",
            code: "MissingPermission",
            message: `Missing required permission: ${permission}`,
          });
        }
      }
    }

    const existing = await this.prisma.appGroup.findFirst({
      where: { tenantId, name: manifest.metadata.name },
      select: { id: true },
    });
    if (existing) {
      errors.push({
        path: "$.metadata.name",
        code: "AppGroupAlreadyExists",
        message: `App Group "${manifest.metadata.name}" already exists`,
      });
    }

    const external = await this.resolveExternalResources(tenantId, manifest);
    this.validateExternalReferences(manifest, external, errors);
    await this.validateRegistries(tenantId, manifest, external, errors);
    await this.validateQuota(tenantId, manifest, errors);

    const domainUses = new Map<string, string>();
    for (const [appIndex, app] of manifest.spec.apps.entries()) {
      for (const [endpointIndex, endpoint] of app.httpEndpoints.entries()) {
        for (const [domainIndex, hostname] of endpoint.domains.entries()) {
          const currentPath = `$.spec.apps[${appIndex}].httpEndpoints[${endpointIndex}].domains[${domainIndex}]`;
          const previousPath = domainUses.get(hostname);
          if (previousPath) {
            errors.push({
              path: currentPath,
              code: "DuplicateDomainReference",
              message: `Domain "${hostname}" is already referenced at ${previousPath}`,
            });
          } else {
            domainUses.set(hostname, currentPath);
          }
        }
      }
    }

    if (manifest.spec.secrets.length > 0) {
      warnings.push({
        path: "$.spec.secrets",
        code: "InlineSecrets",
        message: "This manifest contains secret values. Do not commit it to source control unless those values are intentionally stored there.",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      summary: this.buildSummary(manifest, requiredPermissions),
      preview: redactedManifestPreview(manifest),
    };
  }

  async applyManifest(
    tenantId: string,
    source: string,
    permissions: string[],
    actor: AuthenticatedUser,
  ) {
    const validation = await this.validateManifest(tenantId, source, permissions);
    if (!validation.valid) {
      throw new BadRequestException({
        code: "ManifestValidationFailed",
        message: "App Group manifest validation failed",
        details: validation,
      });
    }

    const parsed = parseAppGroupManifest(source);
    const manifest = parsed.manifest!;
    const external = await this.resolveExternalResources(tenantId, manifest);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const appGroup = await tx.appGroup.create({
          data: {
            tenantId,
            name: manifest.metadata.name,
            description: manifest.metadata.description,
            runtimeState: manifest.spec.runtimeState,
            hasPendingChanges: manifest.spec.apps.length > 0,
            runtimeDraftRevision: manifest.spec.apps.length > 0 ? 1 : 0,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });

        const variableIds = new Map<string, string>();
        for (const variable of manifest.spec.variables) {
          const created = await tx.variable.create({
            data: {
              appGroupId: appGroup.id,
              name: variable.name,
              description: variable.description,
              value: variable.value,
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          });
          variableIds.set(variable.name, created.id);
        }

        const configIds = new Map<string, string>();
        for (const config of manifest.spec.configs) {
          const created = await tx.config.create({
            data: {
              appGroupId: appGroup.id,
              name: config.name,
              description: config.description,
              content: config.content,
              contentVersion: 1,
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          });
          configIds.set(config.name, created.id);
        }

        const secretIds = new Map<string, string>();
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { name: true },
        });
        for (const secret of manifest.spec.secrets) {
          const id = crypto.randomUUID();
          const plaintext = secret.type === "Binary"
            ? Buffer.from(secret.value, "base64")
            : Buffer.from(secret.value, "utf8");
          await tx.secret.create({
            data: {
              id,
              appGroupId: appGroup.id,
              name: secret.name,
              description: secret.description,
              type: secret.type,
              fileName: secret.type === "Binary" ? secret.fileName : null,
              valueVersion: 1,
              keyVersion: 1,
              valueCiphertext: this.secretStorage.seal(plaintext),
              storagePath: null,
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          });
          secretIds.set(secret.name, id);
          await tx.auditLogEntry.create({
            data: {
              tenantId,
              tenantName: tenant.name,
              actor: actor.id,
              actorName: actor.displayName,
              action: "secret.create",
              resourceType: "Secret",
              resourceId: id,
              resourceName: secret.name,
              result: "Success",
              correlationId: crypto.randomUUID(),
              changes: {
                source: "AppGroupManifest",
                type: secret.type,
                fileName: secret.fileName ?? null,
                value: { changed: true },
              },
            },
          });
        }

        for (const app of manifest.spec.apps) {
          const registryId = app.registry
            ? external.registries.get(app.registry)?.id
            : undefined;
          const singleApp = await tx.singleApp.create({
            data: {
              appGroupId: appGroup.id,
              name: app.name,
              description: app.description,
              image: app.image,
              registryId,
              desiredReplicas: app.desiredReplicas,
              runtimeState: app.runtimeState,
              cpu: app.resources.cpu,
              memoryBytes: BigInt(app.resources.memoryBytes),
              gpu: app.resources.gpu,
              environment: app.environment,
              healthCheck: app.healthCheck as Prisma.InputJsonObject | undefined,
              entrypoint: app.entrypoint,
              command: app.command,
              workingDir: app.workingDir,
              user: app.user,
              readOnlyRootFilesystem: app.readOnlyRootFilesystem,
              stopGracePeriodSeconds: app.stopGracePeriodSeconds,
              restartPolicy: (app.restartPolicy ?? DEFAULT_RESTART_POLICY) as Prisma.InputJsonObject,
              updatePolicy: (app.updatePolicy ?? DEFAULT_UPDATE_POLICY) as Prisma.InputJsonObject,
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          });

          for (const attachment of app.variables) {
            await tx.variableAttachment.create({
              data: {
                variableId: variableIds.get(attachment.source)!,
                singleAppId: singleApp.id,
                targetName: attachment.targetName,
                createdBy: actor.id,
              },
            });
          }

          for (const attachment of app.secrets) {
            await tx.secretAttachment.create({
              data: {
                secretId: secretIds.get(attachment.source)!,
                singleAppId: singleApp.id,
                targetName: attachment.targetName,
                createdBy: actor.id,
              },
            });
          }

          for (const attachment of app.configs) {
            await tx.configAttachment.create({
              data: {
                configId: configIds.get(attachment.source)!,
                singleAppId: singleApp.id,
                targetPath: attachment.targetPath,
                createdBy: actor.id,
              },
            });
          }

          for (const attachment of app.volumes) {
            await tx.volumeAttachment.create({
              data: {
                volumeId: external.volumes.get(attachment.source)!.id,
                singleAppId: singleApp.id,
                mountPath: attachment.mountPath,
                mode: attachment.mode,
                createdBy: actor.id,
              },
            });
          }

          for (const endpoint of app.httpEndpoints) {
            const createdEndpoint = await tx.httpEndpoint.create({
              data: {
                singleAppId: singleApp.id,
                name: endpoint.name,
                containerPort: endpoint.containerPort,
                protocolMode: endpoint.protocolMode,
              },
            });
            for (const hostname of endpoint.domains) {
              const domain = external.domains.get(hostname)!;
              const attached = await tx.domain.updateMany({
                where: { id: domain.id, tenantId, httpEndpointId: null },
                data: {
                  httpEndpointId: createdEndpoint.id,
                  updatedBy: actor.id,
                },
              });
              if (attached.count !== 1) {
                throw new ConflictException({
                  code: "DomainAttachmentChanged",
                  message: `Domain "${hostname}" changed after validation. Validate the manifest again.`,
                });
              }
            }
          }
        }

        await tx.auditLogEntry.create({
          data: {
            tenantId,
            tenantName: tenant.name,
            actor: actor.id,
            actorName: actor.displayName,
            action: "appgroup.import",
            resourceType: "AppGroup",
            resourceId: appGroup.id,
            resourceName: appGroup.name,
            result: "Success",
            correlationId: crypto.randomUUID(),
            changes: {
              apiVersion: manifest.apiVersion,
              apps: manifest.spec.apps.length,
              variables: manifest.spec.variables.length,
              secrets: manifest.spec.secrets.length,
              configs: manifest.spec.configs.length,
              source: "YAML",
            },
          },
        });

        return {
          id: appGroup.id,
          name: appGroup.name,
          imported: true,
          hasPendingChanges: appGroup.hasPendingChanges,
          summary: validation.summary,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new BadRequestException({
          code: "ManifestApplyConflict",
          message: "A resource changed after validation. Validate the manifest again.",
        });
      }
      throw error;
    }
  }

  private async resolveExternalResources(
    tenantId: string,
    manifest: AppGroupManifest,
  ): Promise<ExternalResources> {
    const registryNames = [...new Set(manifest.spec.apps.flatMap((app) => app.registry ? [app.registry] : []))];
    const volumeNames = [...new Set(manifest.spec.apps.flatMap((app) => app.volumes.map((volume) => volume.source)))];
    const domainNames = [...new Set(manifest.spec.apps.flatMap((app) => app.httpEndpoints.flatMap((endpoint) => endpoint.domains)))];

    const [registries, volumes, domains] = await Promise.all([
      registryNames.length
        ? this.prisma.registry.findMany({
            where: { tenantId, name: { in: registryNames } },
            select: { id: true, name: true },
          })
        : [],
      volumeNames.length
        ? this.prisma.volume.findMany({
            where: { tenantId, name: { in: volumeNames } },
            select: { id: true, name: true },
          })
        : [],
      domainNames.length
        ? this.prisma.domain.findMany({
            where: { tenantId, hostname: { in: domainNames } },
            select: { id: true, hostname: true, httpEndpointId: true },
          })
        : [],
    ]);

    return {
      registries: new Map(registries.map((registry) => [registry.name, registry])),
      volumes: new Map(volumes.map((volume) => [volume.name, volume])),
      domains: new Map(domains.map((domain) => [domain.hostname, domain])),
    };
  }

  private validateExternalReferences(
    manifest: AppGroupManifest,
    external: ExternalResources,
    errors: ManifestIssue[],
  ) {
    for (const [appIndex, app] of manifest.spec.apps.entries()) {
      if (app.registry && !external.registries.has(app.registry)) {
        errors.push({
          path: `$.spec.apps[${appIndex}].registry`,
          code: "RegistryNotFound",
          message: `Registry "${app.registry}" does not exist in this tenant`,
        });
      }

      for (const [volumeIndex, volume] of app.volumes.entries()) {
        if (!external.volumes.has(volume.source)) {
          errors.push({
            path: `$.spec.apps[${appIndex}].volumes[${volumeIndex}].source`,
            code: "VolumeNotFound",
            message: `Volume "${volume.source}" does not exist in this tenant`,
          });
        }
      }

      for (const [endpointIndex, endpoint] of app.httpEndpoints.entries()) {
        for (const [domainIndex, hostname] of endpoint.domains.entries()) {
          const domain = external.domains.get(hostname);
          const path = `$.spec.apps[${appIndex}].httpEndpoints[${endpointIndex}].domains[${domainIndex}]`;
          if (!domain) {
            errors.push({
              path,
              code: "DomainNotFound",
              message: `Domain "${hostname}" does not exist in this tenant`,
            });
          } else if (domain.httpEndpointId) {
            errors.push({
              path,
              code: "DomainAlreadyAttached",
              message: `Domain "${hostname}" is already attached to another endpoint`,
            });
          }
        }
      }
    }
  }

  private async validateRegistries(
    tenantId: string,
    manifest: AppGroupManifest,
    external: ExternalResources,
    errors: ManifestIssue[],
  ) {
    for (const [appIndex, app] of manifest.spec.apps.entries()) {
      if (!app.registry) continue;
      const registry = external.registries.get(app.registry);
      if (!registry) continue;
      try {
        await this.registriesService.assertRegistryCanBeUsedByImage(
          tenantId,
          registry.id,
          app.image,
        );
      } catch {
        errors.push({
          path: `$.spec.apps[${appIndex}].registry`,
          code: "RegistryMismatch",
          message: `Registry "${app.registry}" does not match image "${app.image}"`,
        });
      }
    }
  }

  private async validateQuota(
    tenantId: string,
    manifest: AppGroupManifest,
    errors: ManifestIssue[],
  ) {
    const quota = await this.prisma.quota.findUnique({ where: { tenantId } });
    if (!quota) return;

    const currentApps = await this.prisma.singleApp.findMany({
      where: { appGroup: { tenantId }, pendingDeletion: false },
      select: { cpu: true, memoryBytes: true, gpu: true, desiredReplicas: true },
    });

    const usage = currentApps.reduce(
      (acc, app) => ({
        cpu: acc.cpu + Number(app.cpu) * app.desiredReplicas,
        memoryBytes: acc.memoryBytes + Number(app.memoryBytes) * app.desiredReplicas,
        gpu: acc.gpu + app.gpu * app.desiredReplicas,
        singleApps: acc.singleApps + 1,
      }),
      { cpu: 0, memoryBytes: 0, gpu: 0, singleApps: 0 },
    );

    const requested = manifest.spec.apps.reduce(
      (acc, app) => ({
        cpu: acc.cpu + app.resources.cpu * app.desiredReplicas,
        memoryBytes: acc.memoryBytes + app.resources.memoryBytes * app.desiredReplicas,
        gpu: acc.gpu + app.resources.gpu * app.desiredReplicas,
        singleApps: acc.singleApps + 1,
      }),
      usage,
    );

    const checks = [
      ["cpu", requested.cpu, Number(quota.cpu)],
      ["memory", requested.memoryBytes, Number(quota.memoryBytes)],
      ["gpu", requested.gpu, quota.gpu],
      ["maxSingleApps", requested.singleApps, quota.maxSingleApps],
    ] as const;

    for (const [resource, value, limit] of checks) {
      if (value > limit) {
        errors.push({
          path: "$.spec.apps",
          code: "QuotaExceeded",
          message: `Quota exceeded for ${resource}: requested ${value}, limit ${limit}`,
        });
      }
    }
  }

  private requiredPermissions(manifest: AppGroupManifest) {
    const permissions = new Set<string>(["appgroup.create"]);
    if (manifest.spec.apps.length) permissions.add("singleapp.create");
    if (manifest.spec.variables.length) permissions.add("variable.create");
    if (manifest.spec.secrets.length) permissions.add("secret.create");
    if (manifest.spec.configs.length) permissions.add("config.create");

    if (manifest.spec.apps.some((app) => app.variables.length)) permissions.add("variable.attach");
    if (manifest.spec.apps.some((app) => app.secrets.length)) permissions.add("secret.attach");
    if (manifest.spec.apps.some((app) => app.configs.length)) permissions.add("config.attach");
    if (manifest.spec.apps.some((app) => app.volumes.length)) permissions.add("volume.attach");
    if (manifest.spec.apps.some((app) => app.httpEndpoints.length)) permissions.add("endpoint.create");
    if (manifest.spec.apps.some((app) => app.httpEndpoints.some((endpoint) => endpoint.domains.length))) {
      permissions.add("domain.update");
    }
    return [...permissions].sort();
  }

  private buildSummary(
    manifest: AppGroupManifest,
    requiredPermissions = this.requiredPermissions(manifest),
  ): ManifestSummary {
    const apps = manifest.spec.apps.length;
    const httpEndpoints = manifest.spec.apps.reduce((sum, app) => sum + app.httpEndpoints.length, 0);
    const domainAttachments = manifest.spec.apps.reduce(
      (sum, app) => sum + app.httpEndpoints.reduce((endpointSum, endpoint) => endpointSum + endpoint.domains.length, 0),
      0,
    );
    const volumeAttachments = manifest.spec.apps.reduce((sum, app) => sum + app.volumes.length, 0);
    return {
      appGroupName: manifest.metadata.name,
      runtimeState: manifest.spec.runtimeState,
      apps,
      variables: manifest.spec.variables.length,
      secrets: manifest.spec.secrets.length,
      configs: manifest.spec.configs.length,
      httpEndpoints,
      domainAttachments,
      volumeAttachments,
      registries: [...new Set(manifest.spec.apps.flatMap((app) => app.registry ? [app.registry] : []))].sort(),
      volumes: [...new Set(manifest.spec.apps.flatMap((app) => app.volumes.map((volume) => volume.source)))].sort(),
      domains: [...new Set(manifest.spec.apps.flatMap((app) => app.httpEndpoints.flatMap((endpoint) => endpoint.domains)))].sort(),
      requiredPermissions,
    };
  }
}
