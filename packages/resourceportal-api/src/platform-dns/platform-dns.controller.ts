import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import type { AuthenticatedUser } from "../auth/types";
import { UpdatePlatformDnsDto } from "./dto/update-platform-dns.dto";
import { ManagedDnsService } from "./managed-dns.service";

@Controller("platform/dns")
@UseGuards(PlatformAdminGuard)
export class PlatformDnsController {
  constructor(private readonly managedDns: ManagedDnsService) {}

  @Get()
  getState() {
    return this.managedDns.getPlatformState();
  }

  @Patch()
  updateState(
    @Body() dto: UpdatePlatformDnsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.managedDns.updatePlatformState(dto, actor);
  }

  @Post("validate")
  validate(@CurrentUser() actor: AuthenticatedUser) {
    return this.managedDns.validatePlatformConnection(actor);
  }
}
