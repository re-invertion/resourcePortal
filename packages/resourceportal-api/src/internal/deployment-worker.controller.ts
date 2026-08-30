import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { AdvanceDeploymentDto } from "./dto/advance-deployment.dto";
import { ClaimDeploymentDto } from "./dto/claim-deployment.dto";
import { FailDeploymentDto } from "./dto/fail-deployment.dto";
import { HeartbeatDeploymentDto } from "./dto/heartbeat-deployment.dto";
import { DeploymentRecoveryService } from "./deployment-recovery.service";
import { DeploymentWorkerService } from "./deployment-worker.service";
import { InternalAuthGuard } from "./internal-auth.guard";

@Public()
@UseGuards(InternalAuthGuard)
@Controller("internal/deployments")
export class DeploymentWorkerController {
  constructor(
    private readonly deploymentRecoveryService: DeploymentRecoveryService,
    private readonly deploymentWorkerService: DeploymentWorkerService,
  ) {}

  @Post("claim")
  claimNextDeployment(@Body() dto: ClaimDeploymentDto) {
    return this.deploymentRecoveryService.claimNextDeployment(dto);
  }

  @Patch(":deploymentId/heartbeat")
  heartbeatDeployment(
    @Param("deploymentId", ParseUUIDPipe) deploymentId: string,
    @Body() dto: HeartbeatDeploymentDto,
  ) {
    return this.deploymentRecoveryService.heartbeatDeployment(deploymentId, dto);
  }

  @Patch(":deploymentId/advance")
  advanceDeployment(
    @Param("deploymentId", ParseUUIDPipe) deploymentId: string,
    @Body() dto: AdvanceDeploymentDto,
  ) {
    return this.deploymentWorkerService.advanceDeployment(deploymentId, dto);
  }

  @Patch(":deploymentId/fail")
  failDeployment(
    @Param("deploymentId", ParseUUIDPipe) deploymentId: string,
    @Body() dto: FailDeploymentDto,
  ) {
    return this.deploymentWorkerService.failDeployment(deploymentId, dto);
  }
}
