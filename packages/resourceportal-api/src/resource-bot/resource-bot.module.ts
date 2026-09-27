import { Module } from "@nestjs/common";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { ObservabilityModule } from "../observability/observability.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { OpenAiResourceBotProvider } from "./openai-resource-bot.provider";
import { PlatformResourceBotController } from "./platform-resource-bot.controller";
import { PlatformResourceBotService } from "./platform-resource-bot.service";
import { ResourceBotRetrievalService } from "./resource-bot-retrieval.service";
import { ResourceBotBillingService } from "./resource-bot-billing.service";
import { ResourceBotChatService } from "./resource-bot-chat.service";
import { TenantResourceBotController } from "./tenant-resource-bot.controller";
import { TenantResourceBotSettingsService } from "./tenant-resource-bot-settings.service";

@Module({
  imports: [ObservabilityModule, PrismaModule, SecurityModule],
  controllers: [PlatformResourceBotController, TenantResourceBotController],
  providers: [
    PlatformAdminGuard,
    OpenAiResourceBotProvider,
    PlatformResourceBotService,
    ResourceBotRetrievalService,
    ResourceBotBillingService,
    TenantResourceBotSettingsService,
    ResourceBotChatService,
  ],
  exports: [
    OpenAiResourceBotProvider,
    PlatformResourceBotService,
    ResourceBotRetrievalService,
    ResourceBotBillingService,
    TenantResourceBotSettingsService,
  ],
})
export class ResourceBotModule {}
