import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { CreateDomainDto } from "./dto/create-domain.dto";
import { UpdateDomainDto } from "./dto/update-domain.dto";
import { DomainsService } from "./domains.service";

@Controller("tenants/:tenantId/domains")
export class DomainsController {
  constructor(private readonly domainsService: DomainsService) {}

  @RequirePermissions("domain.read")
  @Get()
  listDomains(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.domainsService.listDomains(tenantId);
  }

  @RequirePermissions("domain.create")
  @Post()
  createDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateDomainDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.domainsService.createDomain(tenantId, dto, user);
  }

  @RequirePermissions("domain.read")
  @Get(":domainId")
  getDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("domainId", ParseUUIDPipe) domainId: string,
  ) {
    return this.domainsService.getDomain(tenantId, domainId);
  }

  @RequirePermissions("domain.update")
  @Patch(":domainId")
  updateDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("domainId", ParseUUIDPipe) domainId: string,
    @Body() dto: UpdateDomainDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.domainsService.updateDomain(tenantId, domainId, dto, user);
  }

  @RequirePermissions("domain.validate")
  @Post(":domainId/validate")
  validateDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("domainId", ParseUUIDPipe) domainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.domainsService.validateDomain(tenantId, domainId, user);
  }

  @RequirePermissions("domain.delete")
  @Delete(":domainId")
  deleteDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("domainId", ParseUUIDPipe) domainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.domainsService.deleteDomain(tenantId, domainId, user);
  }
}
