import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { ObservabilityService } from "../observability/observability.service";
import { RateLimitService } from "../security/rate-limit.service";
import type { ResourceBotMessageDto } from "./dto/resource-bot-message.dto";
import { OpenAiResourceBotProvider } from "./openai-resource-bot.provider";
import { PlatformResourceBotService } from "./platform-resource-bot.service";
import { ResourceBotBillingService } from "./resource-bot-billing.service";
import { ResourceBotRetrievalService } from "./resource-bot-retrieval.service";
import { TenantResourceBotSettingsService } from "./tenant-resource-bot-settings.service";

@Injectable()
export class ResourceBotChatService {
  constructor(
    private readonly settings: TenantResourceBotSettingsService,
    private readonly platform: PlatformResourceBotService,
    private readonly retrieval: ResourceBotRetrievalService,
    private readonly provider: OpenAiResourceBotProvider,
    private readonly billing: ResourceBotBillingService,
    private readonly rateLimit: RateLimitService,
    private readonly observability: ObservabilityService,
  ) {}

  async answer(
    tenantId: string,
    dto: ResourceBotMessageDto,
    actor: AuthenticatedUser,
  ) {
    const requestId = dto.requestId ?? randomUUID();
    let reservationCreated = false;
    let reservationId: string | undefined;
    let renewalTimer: ReturnType<typeof setInterval> | undefined;

    try {
      await this.settings.assertEnabled(tenantId);
      await this.assertRateLimits(tenantId, actor.id);

      const configuration = await this.platform.getRuntimeConfiguration();
      const reservation = await this.billing.reserve({
        tenantId,
        requestId,
        provider: "OpenAI",
        model: configuration.generationModel,
      });

      if (reservation.duplicate) {
        throw new ConflictException({
          code: "ResourceBotRequestAlreadyProcessed",
          message: "This ResourceBot request has already been processed",
        });
      }
      reservationCreated = true;
      reservationId = reservation.reservationId;
      // Keep the authorized reservation alive while retrieval/generation runs.
      // If the DB cannot extend it, settlement fails closed.
      renewalTimer = setInterval(() => {
        if (reservationId) void this.billing.renew(requestId, tenantId, reservationId).catch(() => undefined);
      }, 60_000);
      renewalTimer.unref();

      const retrievalStartedAt = Date.now();
      let retrievalResult: Awaited<
        ReturnType<ResourceBotRetrievalService["retrieve"]>
      >;
      try {
        retrievalResult = await this.retrieval.retrieve(
          dto.question.trim(),
          configuration,
        );
      } finally {
        this.observability.recordResourceBotDuration(
          "retrieval",
          Date.now() - retrievalStartedAt,
        );
      }

      const sources = retrievalResult.sources;
      if (sources.length === 0) {
        const usage = await this.billing.settle({
          tenantId,
          reservationId: reservation.reservationId,
          requestId,
          actor,
          provider: "OpenAI",
          model: configuration.generationModel,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          embeddingInputTokens: retrievalResult.embeddingInputTokens,
          totalTokens: retrievalResult.embeddingInputTokens,
          supportedByHelp: false,
        });
        reservationCreated = false;
        this.observability.recordResourceBotUsage(usage);
        this.observability.recordResourceBotRequest("abstained");

        return {
          requestId,
          answer:
            "ResourcePortal Help does not document enough information to answer this question.",
          supportedByHelp: false,
          sources: [],
          usage: {
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            embeddingInputTokens: usage.embeddingInputTokens,
            totalTokens: usage.totalTokens,
            chargedCredits: usage.chargedCredits,
          },
        };
      }

      const providerStartedAt = Date.now();
      let result: Awaited<ReturnType<OpenAiResourceBotProvider["answer"]>>;
      try {
        result = await this.provider.answer(configuration, {
          question: dto.question.trim(),
          history: (dto.history ?? []).map((turn) => ({
            role: turn.role,
            content: turn.content.trim(),
          })),
          sources,
        });
      } finally {
        this.observability.recordResourceBotDuration(
          "provider",
          Date.now() - providerStartedAt,
        );
      }

      const usage = await this.billing.settle({
        tenantId,
        reservationId: reservation.reservationId,
        requestId,
        actor,
        provider: "OpenAI",
        model: configuration.generationModel,
        providerRequestId: result.providerRequestId,
        inputTokens: result.usage.inputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
        outputTokens: result.usage.outputTokens,
        embeddingInputTokens: retrievalResult.embeddingInputTokens,
        totalTokens:
          result.usage.totalTokens + retrievalResult.embeddingInputTokens,
        supportedByHelp: result.supportedByHelp,
      });
      reservationCreated = false;
      this.observability.recordResourceBotUsage(usage);
      this.observability.recordResourceBotRequest(
        result.supportedByHelp ? "answered" : "abstained",
      );

      const sourceById = new Map(
        sources.map((source) => [source.chunkId, source] as const),
      );
      const safeSources = result.sourceChunkIds.flatMap((chunkId) => {
        const source = sourceById.get(chunkId);
        if (!source) return [];
        return [{
          chunkId,
          sectionId: source.sectionId,
          title: source.title,
          href:
            "/tenants/" +
            encodeURIComponent(tenantId) +
            "/help#" +
            encodeURIComponent(source.anchor),
        }];
      });

      return {
        requestId,
        answer: result.answer,
        supportedByHelp: result.supportedByHelp,
        sources: safeSources,
        usage: {
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          embeddingInputTokens: usage.embeddingInputTokens,
          totalTokens: usage.totalTokens,
          chargedCredits: usage.chargedCredits,
        },
      };
    } catch (error) {
      if (reservationCreated && reservationId) {
        await this.billing.release(requestId, tenantId, reservationId).catch(() => undefined);
      }
      this.observability.recordResourceBotRequest("error");
      throw error;
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
    }
  }

  private async assertRateLimits(tenantId: string, userId: string) {
    const [userLimit, tenantLimit] = await Promise.all([
      this.rateLimit.consumeWithPolicy(
        "resourcebot:user:" + tenantId + ":" + userId,
        { maxRequests: 20, windowSeconds: 60 },
      ),
      this.rateLimit.consumeWithPolicy(
        "resourcebot:tenant:" + tenantId,
        { maxRequests: 60, windowSeconds: 60 },
      ),
    ]);
    const denied = !userLimit.allowed
      ? userLimit
      : !tenantLimit.allowed
        ? tenantLimit
        : null;
    if (denied) {
      throw new HttpException(
        {
          code: "ResourceBotRateLimited",
          message: "Too many ResourceBot requests",
          retryAfterSeconds: denied.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}