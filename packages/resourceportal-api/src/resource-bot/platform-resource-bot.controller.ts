import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import type { AuthenticatedUser } from "../auth/types";
import { CreateResourceBotPriceDto } from "./dto/create-resource-bot-price.dto";
import { UpdatePlatformResourceBotDto } from "./dto/update-platform-resource-bot.dto";
import { PlatformResourceBotService } from "./platform-resource-bot.service";
import { ResourceBotBillingService } from "./resource-bot-billing.service";

@Controller("platform/resource-bot")
@UseGuards(PlatformAdminGuard)
export class PlatformResourceBotController {
  constructor(
    private readonly resourceBot: PlatformResourceBotService,
    private readonly billing: ResourceBotBillingService,
  ) {}

  @Get()
  getState() {
    return this.resourceBot.getPlatformState();
  }

  @Patch()
  updateState(
    @Body() dto: UpdatePlatformResourceBotDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.resourceBot.updatePlatformState(dto, actor);
  }

  @Get("prices")
  listPrices() {
    return this.billing.listPrices();
  }

  @Post("prices")
  createPrice(
    @Body() dto: CreateResourceBotPriceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.billing.createPrice(dto, actor);
  }

  @Post("validate")
  validate(@CurrentUser() actor: AuthenticatedUser) {
    return this.resourceBot.validatePlatformConnection(actor);
  }
}
