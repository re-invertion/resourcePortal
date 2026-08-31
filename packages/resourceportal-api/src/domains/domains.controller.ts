import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { OperationsService } from "../operations/operations.service";
import { CreateCustomRootDomainDto } from "./dto/create-custom-root-domain.dto";
import { CreateDomainDto } from "./dto/create-domain.dto";
import { UpdateCustomRootDomainDto } from "./dto/update-custom-root-domain.dto";
import { UpdateDomainDto } from "./dto/update-domain.dto";
import { DomainsService } from "./domains.service";

@Controller("tenants/:tenantId/domains")
export class DomainsController {
  constructor(
    private readonly domainsService: DomainsService,
    private readonly operationsService: OperationsService,
  ) {}

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
  @Get("custom-root-domains")
  listCustomRootDomains(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.domainsService.listCustomRootDomains(tenantId);
  }

  @RequirePermissions("domain.create")
  @Post("custom-root-domains")
  createCustomRootDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateCustomRootDomainDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.domainsService.createCustomRootDomain(tenantId, dto, user);
  }

  @RequirePermissions("domain.read")
  @Get("custom-root-domains/:customRootDomainId")
  getCustomRootDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("customRootDomainId", ParseUUIDPipe) customRootDomainId: string,
  ) {
    return this.domainsService.getCustomRootDomain(tenantId, customRootDomainId);
  }

  @RequirePermissions("domain.update")
  @Patch("custom-root-domains/:customRootDomainId")
  updateCustomRootDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("customRootDomainId", ParseUUIDPipe) customRootDomainId: string,
    @Body() dto: UpdateCustomRootDomainDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.domainsService.updateCustomRootDomain(
      tenantId,
      customRootDomainId,
      dto,
      user,
    );
  }

  @RequirePermissions("domain.validate")
  @Post("custom-root-domains/:customRootDomainId/validate")
  @HttpCode(HttpStatus.ACCEPTED)
  validateCustomRootDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("customRootDomainId", ParseUUIDPipe) customRootDomainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.operationsService.enqueue({
      type: "CUSTOM_ROOT_DOMAIN_VERIFY",
      tenantId,
      resourceType: "CustomRootDomain",
      resourceId: customRootDomainId,
      actor: user,
      input: {},
    });
  }

  @RequirePermissions("domain.delete")
  @Delete("custom-root-domains/:customRootDomainId")
  deleteCustomRootDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("customRootDomainId", ParseUUIDPipe) customRootDomainId: string,
  ) {
    return this.domainsService.deleteCustomRootDomain(
      tenantId,
      customRootDomainId,
    );
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
  @HttpCode(HttpStatus.ACCEPTED)
  validateDomain(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("domainId", ParseUUIDPipe) domainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.operationsService.enqueue({
      type: "DOMAIN_VERIFY",
      tenantId,
      resourceType: "Domain",
      resourceId: domainId,
      actor: user,
      input: {},
    });
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
