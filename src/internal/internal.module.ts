import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { DeploymentWorkerController } from "./deployment-worker.controller";
import { DeploymentWorkerService } from "./deployment-worker.service";
import { InternalAuthGuard } from "./internal-auth.guard";
import { StackApplyService } from "./stack-apply.service";
import { StackConfigProvisionerService } from "./stack-config-provisioner.service";
import { StackRegistryAuthService } from "./stack-registry-auth.service";
import { StackRolloutService } from "./stack-rollout.service";
import { StackSecretProvisionerService } from "./stack-secret-provisioner.service";
import { StackVolumeProvisionerService } from "./stack-volume-provisioner.service";

@Module({
  imports: [PrismaModule],
  controllers: [DeploymentWorkerController],
  providers: [
    DeploymentWorkerService,
    InternalAuthGuard,
    StackApplyService,
    StackConfigProvisionerService,
    StackRegistryAuthService,
    StackRolloutService,
    StackSecretProvisionerService,
    StackVolumeProvisionerService,
  ],
})
export class InternalModule {}
