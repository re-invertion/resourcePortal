import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import type { AuthenticatedUser } from "../auth/types";
import { SendTestEmailDto } from "./dto/send-test-email.dto";
import { UpdatePlatformEmailDto } from "./dto/update-platform-email.dto";
import { PlatformEmailService } from "./platform-email.service";

@Controller("platform/email")
@UseGuards(PlatformAdminGuard)
export class PlatformEmailController {
  constructor(private readonly email: PlatformEmailService) {}

  @Get()
  getState() {
    return this.email.getPlatformState();
  }

  @Patch()
  updateState(
    @Body() dto: UpdatePlatformEmailDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.email.updatePlatformState(dto, actor);
  }

  @Post("validate")
  validate(@CurrentUser() actor: AuthenticatedUser) {
    return this.email.validateConnection(actor);
  }

  @Post("test")
  test(
    @Body() dto: SendTestEmailDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.email.sendTestEmail(dto, actor);
  }
}
