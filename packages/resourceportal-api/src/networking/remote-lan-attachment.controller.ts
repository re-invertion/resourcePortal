import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import type { AuthenticatedUser } from "../auth/types";
import { CreateRemoteLanAttachmentDto } from "./dto/create-remote-lan-attachment.dto";
import { RemoteLanAttachmentService } from "./remote-lan-attachment.service";
import {UpdateRemoteLanAddressingDto} from "./dto/update-remote-lan-addressing.dto";

@Controller("tenants/:tenantId/networking/lan-attachments")
export class RemoteLanAttachmentController {
  constructor(private readonly service: RemoteLanAttachmentService) {}

  @RequirePermissions("gate.read")
  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.service.list(tenantId);
  }

  @RequirePermissions("gate.manage")
  @Post()
  create(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateRemoteLanAttachmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.create(tenantId, dto, actor);
  }

  @RequirePermissions("gate.manage")
  @Patch(":id/addressing")
  updateAddressing(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateRemoteLanAddressingDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.updateAddressing(tenantId,id,dto,actor);
  }

  @RequirePermissions("gate.manage")
  @Delete(":id")
  revoke(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.revoke(tenantId, id, actor);
  }
}
