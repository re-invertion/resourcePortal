import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { RegistriesService } from "../registries/registries.service";
import { EncryptionService } from "../security/encryption.service";
import { SecretStorageService } from "../security/secret-storage.service";
import { VolumeReadService } from "../volumes/volume-read.service";
import { Stage11AppGroupsService } from "./stage11-app-groups.service";

/**
 * Compatibility layer for the historical Stage15 service. Runtime mutations moved
 * to AppGroupRuntimeOperationsService in v0.2.0 so this service cannot touch Docker.
 */
@Injectable()
export class Stage15AppGroupsService extends Stage11AppGroupsService {
  constructor(
    prisma: PrismaService,
    registries: RegistriesService,
    encryption: EncryptionService,
    secretStorage: SecretStorageService,
    volumes: VolumeReadService,
    config: ConfigService,
  ) {
    super(prisma, registries, encryption, secretStorage, volumes, config);
  }
}
