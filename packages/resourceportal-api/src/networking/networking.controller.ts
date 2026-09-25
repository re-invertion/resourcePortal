import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { Public } from "../auth/public.decorator";
import { RequirePermissions } from "../auth/require-permissions.decorator";
import type { AuthenticatedUser } from "../auth/types";
import { OperationsService } from "../operations/operations.service";
import { AttachGateNetworkDto } from "./dto/attach-gate-network.dto";
import { AttachNetworkDto } from "./dto/attach-network.dto";
import { CreateGateDto } from "./dto/create-gate.dto";
import { CreateNetworkDto } from "./dto/create-network.dto";
import { GateEnrollDto } from "./dto/gate-enroll.dto";
import { GateHeartbeatDto } from "./dto/gate-heartbeat.dto";
import { UpdateNetworkDto } from "./dto/update-network.dto";
import { resourcePortalGateInstallerScript } from "./gate-installer";
import { NetworkingService } from "./networking.service";

@Controller("tenants/:tenantId/networking")
export class NetworkingController {
  constructor(
    private readonly networking: NetworkingService,
    private readonly operations: OperationsService,
  ) {}

  @RequirePermissions("network.read")
  @Get("topology")
  topology(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.networking.topology(tenantId);
  }

  @RequirePermissions("network.read")
  @Get("networks")
  listNetworks(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.networking.listNetworks(tenantId);
  }

  @RequirePermissions("network.create")
  @Post("networks")
  createNetwork(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateNetworkDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.networking.createNetwork(tenantId, dto, actor);
  }

  @RequirePermissions("network.update")
  @Patch("networks/:networkId")
  updateNetwork(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("networkId", ParseUUIDPipe) networkId: string,
    @Body() dto: UpdateNetworkDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.networking.updateNetwork(tenantId, networkId, dto, actor);
  }

  @RequirePermissions("network.delete")
  @Delete("networks/:networkId")
  deleteNetwork(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("networkId", ParseUUIDPipe) networkId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.networking.deleteNetwork(tenantId, networkId, actor);
  }

  @RequirePermissions("network.attach")
  @Post("networks/:networkId/attachments")
  @HttpCode(HttpStatus.ACCEPTED)
  async attachApplication(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("networkId", ParseUUIDPipe) networkId: string,
    @Body() dto: AttachNetworkDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const snapshot = await this.networking.topologyChangeSnapshot(tenantId, {
      action: "APP_ATTACH",
      networkId,
      singleAppId: dto.singleAppId,
    });
    return this.operations.enqueue({
      type: "NETWORK_TOPOLOGY_CHANGE",
      tenantId,
      resourceType: "Network",
      resourceId: networkId,
      actor,
      idempotencyKey,
      input: {
        action: "APP_ATTACH",
        networkId,
        singleAppId: dto.singleAppId,
        address: dto.address,
        expectedRevision: dto.expectedRevision ?? snapshot.networkRevision,
        snapshot,
      },
    });
  }

  @RequirePermissions("network.attach")
  @Delete("networks/:networkId/attachments/:attachmentId")
  @HttpCode(HttpStatus.ACCEPTED)
  async detachApplication(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("networkId", ParseUUIDPipe) networkId: string,
    @Param("attachmentId", ParseUUIDPipe) attachmentId: string,
    @Query("revision", new ParseIntPipe({ optional: true }))
    revision: number | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const snapshot = await this.networking.topologyChangeSnapshot(tenantId, {
      action: "APP_DETACH",
      networkId,
      attachmentId,
    });
    return this.operations.enqueue({
      type: "NETWORK_TOPOLOGY_CHANGE",
      tenantId,
      resourceType: "Network",
      resourceId: networkId,
      actor,
      idempotencyKey,
      input: {
        action: "APP_DETACH",
        networkId,
        attachmentId,
        expectedRevision: revision ?? snapshot.networkRevision,
        snapshot,
      },
    });
  }

  @RequirePermissions("gate.read")
  @Get("gates")
  listGates(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.networking.listGates(tenantId);
  }

  @RequirePermissions("gate.create")
  @Post("gates")
  createGate(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateGateDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.networking.createGate(tenantId, dto, actor);
  }

  @RequirePermissions("gate.manage")
  @Post("gates/:gateId/enrollment")
  createGateEnrollment(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("gateId", ParseUUIDPipe) gateId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.networking.createGateEnrollment(tenantId, gateId, actor);
  }

  @RequirePermissions("gate.manage")
  @Post("gates/:gateId/networks")
  @HttpCode(HttpStatus.ACCEPTED)
  async attachGateNetwork(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("gateId", ParseUUIDPipe) gateId: string,
    @Body() dto: AttachGateNetworkDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const snapshot = await this.networking.topologyChangeSnapshot(tenantId, {
      action: "GATE_ATTACH",
      gateId,
      networkId: dto.networkId,
    });
    return this.operations.enqueue({
      type: "NETWORK_TOPOLOGY_CHANGE",
      tenantId,
      resourceType: "ResourcePortalGate",
      resourceId: gateId,
      actor,
      idempotencyKey,
      input: {
        action: "GATE_ATTACH",
        gateId,
        networkId: dto.networkId,
        expectedRevision: dto.expectedRevision ?? snapshot.gateRevision,
        snapshot,
      },
    });
  }

  @RequirePermissions("gate.manage")
  @Delete("gates/:gateId/networks/:networkId")
  @HttpCode(HttpStatus.ACCEPTED)
  async detachGateNetwork(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("gateId", ParseUUIDPipe) gateId: string,
    @Param("networkId", ParseUUIDPipe) networkId: string,
    @Query("revision", new ParseIntPipe({ optional: true }))
    revision: number | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const snapshot = await this.networking.topologyChangeSnapshot(tenantId, {
      action: "GATE_DETACH",
      gateId,
      networkId,
    });
    return this.operations.enqueue({
      type: "NETWORK_TOPOLOGY_CHANGE",
      tenantId,
      resourceType: "ResourcePortalGate",
      resourceId: gateId,
      actor,
      idempotencyKey,
      input: {
        action: "GATE_DETACH",
        gateId,
        networkId,
        expectedRevision: revision ?? snapshot.gateRevision,
        snapshot,
      },
    });
  }

  @RequirePermissions("gate.delete")
  @Delete("gates/:gateId")
  revokeGate(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("gateId", ParseUUIDPipe) gateId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.networking.revokeGate(tenantId, gateId, actor);
  }
}

@Public()
@Controller("networking/gates")
export class GateAgentController {
  constructor(private readonly networking: NetworkingService) {}

  @Get("install.sh")
  @Header("content-type", "text/x-shellscript; charset=utf-8")
  installScript() {
    return resourcePortalGateInstallerScript();
  }

  @Post("enroll")
  enroll(@Body() dto: GateEnrollDto) {
    return this.networking.enrollGate(dto);
  }

  @Post("agent/heartbeat")
  heartbeat(
    @Headers("authorization") authorization: string | undefined,
    @Body() dto: GateHeartbeatDto,
  ) {
    return this.networking.gateHeartbeat(authorization, dto);
  }

  @Get("agent/config")
  config(@Headers("authorization") authorization: string | undefined) {
    return this.networking.gateAgentConfig(authorization);
  }
}
