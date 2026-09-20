import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import type { AuthenticatedUser } from "../auth/types";
import { CreateNetworkEgressRuleDto } from "./dto/create-network-egress-rule.dto";
import { UpdateNetworkEgressPolicyDto } from "./dto/update-network-egress-policy.dto";
import { NetworkEgressService } from "./network-egress.service";

@Controller("platform/network-egress")
@UseGuards(PlatformAdminGuard)
export class NetworkEgressController {
  constructor(private readonly egress: NetworkEgressService) {}

  @Get()
  getState() {
    return this.egress.getPlatformState();
  }

  @Patch()
  updatePolicy(
    @Body() dto: UpdateNetworkEgressPolicyDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.egress.updatePolicy(dto, actor);
  }

  @Post("rules")
  createRule(
    @Body() dto: CreateNetworkEgressRuleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.egress.createRule(dto, actor);
  }

  @Delete("rules/:ruleId")
  deleteRule(
    @Param("ruleId") ruleId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.egress.deleteRule(ruleId, actor);
  }
}
