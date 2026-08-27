import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import { AuthenticatedUser } from "../auth/types";
import { AppGroupsService } from "./app-groups.service";
import { AttachConfigDto } from "./dto/attach-config.dto";
import { AttachVariableDto } from "./dto/attach-variable.dto";
import { AttachVolumeDto } from "./dto/attach-volume.dto";
import { CreateAppGroupDto } from "./dto/create-app-group.dto";
import { CreateConfigDto } from "./dto/create-config.dto";
import { CreateHttpEndpointDto } from "./dto/create-http-endpoint.dto";
import { CreateSingleAppDto } from "./dto/create-single-app.dto";
import { CreateVariableDto } from "./dto/create-variable.dto";
import { DeployAppGroupDto } from "./dto/deploy-app-group.dto";
import { RollbackDeploymentDto } from "./dto/rollback-deployment.dto";
import { UpdateConfigDto } from "./dto/update-config.dto";
import { UpdateHttpEndpointDto } from "./dto/update-http-endpoint.dto";
import { UpdateRuntimeConfigDto } from "./dto/update-runtime-config.dto";
import { UpdateSingleAppDto } from "./dto/update-single-app.dto";
import { UpdateVariableDto } from "./dto/update-variable.dto";

@Controller("tenants/:tenantId/app-groups")
export class AppGroupsController {
  constructor(private readonly appGroupsService: AppGroupsService) {}

  @RequirePermissions("appgroup.read")
  @Get()
  listAppGroups(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.appGroupsService.listAppGroups(tenantId);
  }

  @RequirePermissions("appgroup.create")
  @Post()
  createAppGroup(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateAppGroupDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.createAppGroup(tenantId, dto, user);
  }

  @RequirePermissions("appgroup.read")
  @Get(":appGroupId")
  getAppGroup(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
  ) {
    return this.appGroupsService.getAppGroup(tenantId, appGroupId);
  }

  @RequirePermissions("appgroup.deployment.read")
  @Get(":appGroupId/deployments")
  listDeployments(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
  ) {
    return this.appGroupsService.listDeployments(tenantId, appGroupId);
  }

  @RequirePermissions("appgroup.deployment.read")
  @Get(":appGroupId/deployments/:deploymentId")
  getDeployment(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("deploymentId", ParseUUIDPipe) deploymentId: string,
  ) {
    return this.appGroupsService.getDeployment(
      tenantId,
      appGroupId,
      deploymentId,
    );
  }

  @RequirePermissions("appgroup.deployment.read")
  @Get(":appGroupId/deployments/:deploymentId/events")
  listDeploymentEvents(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("deploymentId", ParseUUIDPipe) deploymentId: string,
  ) {
    return this.appGroupsService.listDeploymentEvents(
      tenantId,
      appGroupId,
      deploymentId,
    );
  }

  @RequirePermissions("appgroup.deploy")
  @Post(":appGroupId/deployments/:deploymentId/rollback")
  rollbackDeployment(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("deploymentId", ParseUUIDPipe) deploymentId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: RollbackDeploymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.rollbackDeployment(
      tenantId,
      appGroupId,
      deploymentId,
      dto,
      idempotencyKey,
      user,
    );
  }

  @RequirePermissions("appgroup.deploy")
  @Post(":appGroupId/deploy")
  deployAppGroup(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: DeployAppGroupDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.deployAppGroup(
      tenantId,
      appGroupId,
      dto,
      idempotencyKey,
      user,
    );
  }

  @RequirePermissions("variable.read")
  @Get(":appGroupId/variables")
  listVariables(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
  ) {
    return this.appGroupsService.listVariables(tenantId, appGroupId);
  }

  @RequirePermissions("variable.create")
  @Post(":appGroupId/variables")
  createVariable(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Body() dto: CreateVariableDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.createVariable(tenantId, appGroupId, dto, user);
  }

  @RequirePermissions("variable.update")
  @Patch(":appGroupId/variables/:variableId")
  updateVariable(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("variableId", ParseUUIDPipe) variableId: string,
    @Body() dto: UpdateVariableDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.updateVariable(
      tenantId,
      appGroupId,
      variableId,
      dto,
      user,
    );
  }

  @RequirePermissions("variable.delete")
  @Delete(":appGroupId/variables/:variableId")
  deleteVariable(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("variableId", ParseUUIDPipe) variableId: string,
  ) {
    return this.appGroupsService.deleteVariable(tenantId, appGroupId, variableId);
  }

  @RequirePermissions("config.read")
  @Get(":appGroupId/configs")
  listConfigs(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
  ) {
    return this.appGroupsService.listConfigs(tenantId, appGroupId);
  }

  @RequirePermissions("config.create")
  @Post(":appGroupId/configs")
  createConfig(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Body() dto: CreateConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.createConfig(tenantId, appGroupId, dto, user);
  }

  @RequirePermissions("config.update")
  @Patch(":appGroupId/configs/:configId")
  updateConfig(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("configId", ParseUUIDPipe) configId: string,
    @Body() dto: UpdateConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.updateConfig(
      tenantId,
      appGroupId,
      configId,
      dto,
      user,
    );
  }

  @RequirePermissions("config.delete")
  @Delete(":appGroupId/configs/:configId")
  deleteConfig(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("configId", ParseUUIDPipe) configId: string,
  ) {
    return this.appGroupsService.deleteConfig(tenantId, appGroupId, configId);
  }

  @RequirePermissions("singleapp.read")
  @Get(":appGroupId/single-apps")
  listSingleApps(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
  ) {
    return this.appGroupsService.listSingleApps(tenantId, appGroupId);
  }

  @RequirePermissions("singleapp.create")
  @Post(":appGroupId/single-apps")
  createSingleApp(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Body() dto: CreateSingleAppDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.createSingleApp(
      tenantId,
      appGroupId,
      dto,
      user,
    );
  }

  @RequirePermissions("singleapp.update")
  @Patch(":appGroupId/single-apps/:singleAppId")
  updateSingleApp(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Body() dto: UpdateSingleAppDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.updateSingleApp(
      tenantId,
      appGroupId,
      singleAppId,
      dto,
      user,
    );
  }

  @RequirePermissions("singleapp.delete")
  @Delete(":appGroupId/single-apps/:singleAppId")
  deleteSingleApp(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.markSingleAppPendingDeletion(
      tenantId,
      appGroupId,
      singleAppId,
      user,
    );
  }

  @RequirePermissions("singleapp.read", "variable.read", "secret.read")
  @Get(":appGroupId/single-apps/:singleAppId/runtime-config")
  getRuntimeConfig(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
  ) {
    return this.appGroupsService.getSingleAppRuntimeConfig(
      tenantId,
      appGroupId,
      singleAppId,
    );
  }

  @RequirePermissions("endpoint.read")
  @Get(":appGroupId/single-apps/:singleAppId/http-endpoints")
  listHttpEndpoints(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
  ) {
    return this.appGroupsService.listHttpEndpoints(
      tenantId,
      appGroupId,
      singleAppId,
    );
  }

  @RequirePermissions("endpoint.create")
  @Post(":appGroupId/single-apps/:singleAppId/http-endpoints")
  createHttpEndpoint(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Body() dto: CreateHttpEndpointDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.createHttpEndpoint(
      tenantId,
      appGroupId,
      singleAppId,
      dto,
      user,
    );
  }

  @RequirePermissions("endpoint.read")
  @Get(":appGroupId/single-apps/:singleAppId/http-endpoints/:httpEndpointId")
  getHttpEndpoint(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Param("httpEndpointId", ParseUUIDPipe) httpEndpointId: string,
  ) {
    return this.appGroupsService.getHttpEndpoint(
      tenantId,
      appGroupId,
      singleAppId,
      httpEndpointId,
    );
  }

  @RequirePermissions("endpoint.update")
  @Patch(":appGroupId/single-apps/:singleAppId/http-endpoints/:httpEndpointId")
  updateHttpEndpoint(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Param("httpEndpointId", ParseUUIDPipe) httpEndpointId: string,
    @Body() dto: UpdateHttpEndpointDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.updateHttpEndpoint(
      tenantId,
      appGroupId,
      singleAppId,
      httpEndpointId,
      dto,
      user,
    );
  }

  @RequirePermissions("endpoint.delete")
  @Delete(":appGroupId/single-apps/:singleAppId/http-endpoints/:httpEndpointId")
  deleteHttpEndpoint(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Param("httpEndpointId", ParseUUIDPipe) httpEndpointId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.deleteHttpEndpoint(
      tenantId,
      appGroupId,
      singleAppId,
      httpEndpointId,
      user,
    );
  }

  @RequirePermissions("singleapp.update", "variable.update", "secret.update")
  @Patch(":appGroupId/single-apps/:singleAppId/runtime-config")
  updateRuntimeConfig(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Body() dto: UpdateRuntimeConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.updateSingleAppRuntimeConfig(
      tenantId,
      appGroupId,
      singleAppId,
      dto,
      user,
    );
  }

  @RequirePermissions("variable.attach")
  @Post(":appGroupId/single-apps/:singleAppId/variable-attachments")
  attachVariable(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Body() dto: AttachVariableDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.attachVariable(
      tenantId,
      appGroupId,
      singleAppId,
      dto,
      user,
    );
  }

  @RequirePermissions("variable.attach")
  @Delete(
    ":appGroupId/single-apps/:singleAppId/variable-attachments/:attachmentId",
  )
  detachVariable(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Param("attachmentId", ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.detachVariable(
      tenantId,
      appGroupId,
      singleAppId,
      attachmentId,
      user,
    );
  }

  @RequirePermissions("config.attach")
  @Post(":appGroupId/single-apps/:singleAppId/config-attachments")
  attachConfig(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Body() dto: AttachConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.attachConfig(
      tenantId,
      appGroupId,
      singleAppId,
      dto,
      user,
    );
  }

  @RequirePermissions("config.attach")
  @Delete(
    ":appGroupId/single-apps/:singleAppId/config-attachments/:attachmentId",
  )
  detachConfig(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Param("attachmentId", ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.detachConfig(
      tenantId,
      appGroupId,
      singleAppId,
      attachmentId,
      user,
    );
  }

  @RequirePermissions("volume.attach")
  @Post(":appGroupId/single-apps/:singleAppId/volume-attachments")
  attachVolume(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Body() dto: AttachVolumeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.attachVolume(
      tenantId,
      appGroupId,
      singleAppId,
      dto,
      user,
    );
  }

  @RequirePermissions("volume.detach")
  @Delete(
    ":appGroupId/single-apps/:singleAppId/volume-attachments/:attachmentId",
  )
  detachVolume(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("appGroupId", ParseUUIDPipe) appGroupId: string,
    @Param("singleAppId", ParseUUIDPipe) singleAppId: string,
    @Param("attachmentId", ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appGroupsService.detachVolume(
      tenantId,
      appGroupId,
      singleAppId,
      attachmentId,
      user,
    );
  }
}
