import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  RegistryAuthType,
  RegistryTlsMode,
  RegistryValidationStatus,
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { CreateRegistryDto } from "./dto/create-registry.dto";
import { UpdateRegistryDto } from "./dto/update-registry.dto";
import { getDockerImageHost } from "./docker-image";
import { mapRegistry } from "./registries.view";

@Injectable()
export class RegistriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async listRegistries(tenantId: string) {
    const registries = await this.prisma.registry.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });

    return registries.map(mapRegistry);
  }

  async getRegistry(tenantId: string, registryId: string) {
    const registry = await this.findRegistryOrThrow(tenantId, registryId);
    return mapRegistry(registry);
  }

  async createRegistry(
    tenantId: string,
    dto: CreateRegistryDto,
    actor: AuthenticatedUser,
  ) {
    try {
      const registry = await this.prisma.registry.create({
        data: {
          tenantId,
          name: dto.name,
          description: dto.description,
          host: this.normalizeHost(dto.host),
          tlsMode: dto.tlsMode ?? RegistryTlsMode.TLS,
          authType: dto.authType ?? RegistryAuthType.None,
          username: dto.username,
          credentialData: this.toCredentialData(dto.credential),
          validationStatus: RegistryValidationStatus.Unknown,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });

      return mapRegistry(registry);
    } catch (error) {
      this.handleKnownConflict(error, "Registry name already exists");
      throw error;
    }
  }

  async updateRegistry(
    tenantId: string,
    registryId: string,
    dto: UpdateRegistryDto,
    actor: AuthenticatedUser,
  ) {
    await this.findRegistryOrThrow(tenantId, registryId);

    try {
      const registry = await this.prisma.registry.update({
        where: { id: registryId },
        data: {
          name: dto.name,
          description: dto.description,
          host: dto.host ? this.normalizeHost(dto.host) : undefined,
          tlsMode: dto.tlsMode,
          authType: dto.authType,
          username: dto.username,
          credentialData:
            dto.credential !== undefined
              ? this.toCredentialData(dto.credential)
              : undefined,
          validationStatus: RegistryValidationStatus.Unknown,
          lastValidationError: null,
          updatedBy: actor.id,
        },
      });

      if (this.updateTouchesRuntime(dto)) {
        await this.markUsingAppGroupsPending(tenantId, registryId, actor.id);
      }

      return mapRegistry(registry);
    } catch (error) {
      this.handleKnownConflict(error, "Registry name already exists");
      throw error;
    }
  }

  async deleteRegistry(tenantId: string, registryId: string) {
    await this.findRegistryOrThrow(tenantId, registryId);

    const usageCount = await this.prisma.singleApp.count({
      where: { registryId },
    });

    if (usageCount > 0) {
      throw new ConflictException("RegistryInUse");
    }

    await this.prisma.registry.delete({
      where: { id: registryId },
    });

    return { deleted: true };
  }

  async validateRegistry(
    tenantId: string,
    registryId: string,
    actor: AuthenticatedUser,
  ) {
    await this.findRegistryOrThrow(tenantId, registryId);

    const registry = await this.prisma.registry.update({
      where: { id: registryId },
      data: {
        validationStatus: RegistryValidationStatus.Valid,
        lastValidatedAt: new Date(),
        lastValidationError: null,
        updatedBy: actor.id,
      },
    });

    return mapRegistry(registry);
  }

  async assertRegistryCanBeUsedByImage(
    tenantId: string,
    registryId: string | null | undefined,
    image: string,
  ) {
    if (!registryId) {
      return;
    }

    const registry = await this.findRegistryOrThrow(tenantId, registryId);
    const imageHost = getDockerImageHost(image);

    if (registry.host !== imageHost) {
      throw new ConflictException({
        message: "RegistryMismatch",
        registryHost: registry.host,
        imageHost,
      });
    }
  }

  private async findRegistryOrThrow(tenantId: string, registryId: string) {
    const registry = await this.prisma.registry.findFirst({
      where: { id: registryId, tenantId },
    });

    if (!registry) {
      throw new NotFoundException("Registry not found");
    }

    return registry;
  }

  private normalizeHost(host: string) {
    return host
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .toLowerCase();
  }

  private toCredentialData(
    credential: string | undefined,
  ): Prisma.InputJsonObject | undefined {
    if (!credential) {
      return undefined;
    }

    return {
      id: randomUUID(),
      algorithm: "aes-256-gcm",
      digest: createHash("sha256").update(credential).digest("hex"),
      valueCiphertext: this.encryption.encrypt(credential),
    };
  }

  private updateTouchesRuntime(dto: UpdateRegistryDto) {
    return (
      dto.host !== undefined ||
      dto.tlsMode !== undefined ||
      dto.authType !== undefined ||
      dto.username !== undefined ||
      dto.credential !== undefined
    );
  }

  private async markUsingAppGroupsPending(
    tenantId: string,
    registryId: string,
    actorId: string,
  ) {
    const appGroups = await this.prisma.appGroup.findMany({
      where: {
        tenantId,
        singleApps: {
          some: { registryId },
        },
      },
      select: { id: true },
    });

    await this.prisma.appGroup.updateMany({
      where: {
        id: {
          in: appGroups.map((appGroup) => appGroup.id),
        },
      },
      data: {
        hasPendingChanges: true,
        updatedBy: actorId,
      },
    });
  }

  private handleKnownConflict(error: unknown, message: string) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictException(message);
    }
  }
}
