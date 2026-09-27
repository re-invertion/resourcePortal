import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import type { UpdatePlatformResourceBotDto } from "./dto/update-platform-resource-bot.dto";
import { OpenAiResourceBotProvider } from "./openai-resource-bot.provider";
import {
  PLATFORM_RESOURCE_BOT_SETTINGS_ID,
  RESOURCE_BOT_DEFAULT_EMBEDDING_MODEL,
  RESOURCE_BOT_DEFAULT_GENERATION_MODEL,
  RESOURCE_BOT_DEFAULT_PROVIDER,
} from "./resource-bot.constants";
import type { ResourceBotProviderConfiguration } from "./resource-bot-provider";

@Injectable()
export class PlatformResourceBotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly openAi: OpenAiResourceBotProvider,
  ) {}

  async getPlatformState() {
    return this.toView(await this.getState());
  }

  async updatePlatformState(
    dto: UpdatePlatformResourceBotDto,
    actor: AuthenticatedUser,
  ) {
    const current = await this.getState();
    const provider = dto.provider?.trim() || current.provider;
    const generationModel =
      dto.generationModel?.trim() || current.generationModel;
    const embeddingModel = dto.embeddingModel?.trim() || current.embeddingModel;
    const enabled = dto.enabled ?? current.enabled;
    const apiKey =
      dto.apiKey?.trim() ||
      (current.apiKeyCiphertext
        ? this.encryption.decrypt(current.apiKeyCiphertext)
        : undefined);

    if (provider !== "OpenAI") {
      throw new BadRequestException("Only the OpenAI provider is supported");
    }
    if (enabled && !apiKey) {
      throw new BadRequestException(
        "An OpenAI API key is required before ResourceBot can be enabled",
      );
    }

    const configurationChanged = Boolean(
      dto.apiKey || dto.provider || dto.generationModel || dto.embeddingModel,
    );
    let validatedAt: Date | undefined;
    if (configurationChanged || (enabled && !current.lastValidatedAt)) {
      if (!apiKey) {
        throw new BadRequestException("OpenAI API key is not configured");
      }
      try {
        await this.openAi.validateCredential({
          apiKey,
          generationModel,
          embeddingModel,
        });
        validatedAt = new Date();
      } catch (error) {
        await this.prisma.platformResourceBotSettings.update({
          where: { id: PLATFORM_RESOURCE_BOT_SETTINGS_ID },
          data: {
            lastError: safeProviderMessage(error),
            updatedBy: actor.id,
          },
        });
        this.throwProviderError(error);
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const state = await tx.platformResourceBotSettings.update({
        where: { id: PLATFORM_RESOURCE_BOT_SETTINGS_ID },
        data: {
          enabled,
          provider,
          generationModel,
          embeddingModel,
          apiKeyCiphertext: dto.apiKey
            ? this.encryption.encrypt(dto.apiKey.trim())
            : undefined,
          lastValidatedAt: validatedAt,
          lastError: validatedAt ? null : undefined,
          updatedBy: actor.id,
        },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId: null,
          tenantName: "Platform",
          actor: actor.id,
          actorName: actor.displayName,
          action: "platform.resourcebot.update",
          resourceType: "PlatformResourceBotSettings",
          resourceId: state.id,
          resourceName: "ResourceBot",
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            enabled: state.enabled,
            provider: state.provider,
            generationModel: state.generationModel,
            embeddingModel: state.embeddingModel,
            apiKeyConfigured: Boolean(state.apiKeyCiphertext),
          },
        },
      });
      return state;
    });

    return this.toView(updated);
  }

  async validatePlatformConnection(actor: AuthenticatedUser) {
    const state = await this.getState();
    const configuration = this.configuration(state, false);
    try {
      await this.openAi.validateCredential(configuration);
      const updated = await this.prisma.platformResourceBotSettings.update({
        where: { id: PLATFORM_RESOURCE_BOT_SETTINGS_ID },
        data: {
          lastValidatedAt: new Date(),
          lastError: null,
          updatedBy: actor.id,
        },
      });
      return this.toView(updated);
    } catch (error) {
      await this.prisma.platformResourceBotSettings.update({
        where: { id: PLATFORM_RESOURCE_BOT_SETTINGS_ID },
        data: {
          lastError: safeProviderMessage(error),
          updatedBy: actor.id,
        },
      });
      this.throwProviderError(error);
    }
  }

  async getRuntimeConfiguration(): Promise<ResourceBotProviderConfiguration> {
    const state = await this.getState();
    return this.configuration(state, true);
  }

  async getRuntimeState() {
    const state = await this.getState();
    return {
      enabled: state.enabled,
      configured: Boolean(state.apiKeyCiphertext),
      available: this.isAvailable(state),
      provider: state.provider,
      generationModel: state.generationModel,
      embeddingModel: state.embeddingModel,
      lastValidatedAt: state.lastValidatedAt,
      lastError: state.lastError,
    };
  }

  private async getState() {
    return this.prisma.platformResourceBotSettings.upsert({
      where: { id: PLATFORM_RESOURCE_BOT_SETTINGS_ID },
      create: {
        id: PLATFORM_RESOURCE_BOT_SETTINGS_ID,
        enabled: true,
        provider: RESOURCE_BOT_DEFAULT_PROVIDER,
        generationModel: RESOURCE_BOT_DEFAULT_GENERATION_MODEL,
        embeddingModel: RESOURCE_BOT_DEFAULT_EMBEDDING_MODEL,
      },
      update: {},
    });
  }

  private configuration(
    state: Awaited<ReturnType<PlatformResourceBotService["getState"]>>,
    requireAvailable: boolean,
  ): ResourceBotProviderConfiguration {
    if (requireAvailable && !this.isAvailable(state)) {
      throw new ConflictException({
        code: "ResourceBotPlatformNotConfigured",
        message: state.enabled
          ? "ResourceBot is not configured or validated by the Platform Administrator"
          : "ResourceBot is disabled by the Platform Administrator",
      });
    }
    if (!state.apiKeyCiphertext) {
      throw new ConflictException({
        code: "ResourceBotPlatformNotConfigured",
        message: "ResourceBot provider credential is not configured",
      });
    }
    return {
      apiKey: this.encryption.decrypt(state.apiKeyCiphertext),
      generationModel: state.generationModel,
      embeddingModel: state.embeddingModel,
    };
  }

  private isAvailable(state: {
    enabled: boolean;
    apiKeyCiphertext: string | null;
    lastValidatedAt: Date | null;
    lastError: string | null;
  }) {
    return Boolean(
      state.enabled &&
        state.apiKeyCiphertext &&
        state.lastValidatedAt &&
        !state.lastError,
    );
  }

  private toView(
    state: Awaited<ReturnType<PlatformResourceBotService["getState"]>>,
  ) {
    return {
      provider: state.provider,
      enabled: state.enabled,
      configured: Boolean(state.apiKeyCiphertext),
      available: this.isAvailable(state),
      apiKeyConfigured: Boolean(state.apiKeyCiphertext),
      generationModel: state.generationModel,
      embeddingModel: state.embeddingModel,
      lastValidatedAt: state.lastValidatedAt,
      lastError: state.lastError,
      updatedAt: state.updatedAt,
    };
  }

  private throwProviderError(error: unknown): never {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined;

    if (status === 400 || status === 401 || status === 403 || status === 404) {
      throw new BadRequestException({
        code: "ResourceBotProviderConfigurationError",
        message: safeProviderMessage(error),
      });
    }
    throw new BadGatewayException({
      code: "ResourceBotProviderUnavailable",
      message: safeProviderMessage(error),
    });
  }
}

function safeProviderMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 1_000);
  }
  return "OpenAI provider validation failed";
}
