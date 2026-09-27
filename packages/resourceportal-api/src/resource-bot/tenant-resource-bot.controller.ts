import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import type { AuthenticatedUser } from "../auth/types";
import { ResourceBotMessageDto } from "./dto/resource-bot-message.dto";
import { UpdateTenantResourceBotDto } from "./dto/update-tenant-resource-bot.dto";
import { ResourceBotBillingService } from "./resource-bot-billing.service";
import { ResourceBotChatService } from "./resource-bot-chat.service";
import { TenantResourceBotSettingsService } from "./tenant-resource-bot-settings.service";

@Controller("tenants/:tenantId/resource-bot")
export class TenantResourceBotController {
  constructor(
    private readonly settings: TenantResourceBotSettingsService,
    private readonly chat: ResourceBotChatService,
    private readonly billing: ResourceBotBillingService,
  ) {}

  @RequirePermissions("resourcebot.settings.manage")
  @Get("settings")
  getSettings(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.settings.getSettings(tenantId);
  }

  @RequirePermissions("resourcebot.settings.manage")
  @Patch("settings")
  updateSettings(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: UpdateTenantResourceBotDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.settings.updateSettings(tenantId, dto, actor);
  }

  @RequirePermissions("resourcebot.use")
  @Get("status")
  getStatus(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.settings.getStatus(tenantId);
  }

  @RequirePermissions("resourcebot.use")
  @Post("messages")
  answer(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: ResourceBotMessageDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ) {
    if (request.serviceIdentity) {
      throw new ForbiddenException(
        "ResourceBot is available only to interactive tenant users",
      );
    }
    return this.chat.answer(tenantId, dto, actor);
  }

  @RequirePermissions("billing.read")
  @Get("usage")
  usage(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Query("limit") limit?: string,
  ) {
    const parsed = Number.parseInt(limit ?? "50", 10);
    return this.billing.listUsage(
      tenantId,
      Number.isFinite(parsed) ? parsed : 50,
    );
  }
}
