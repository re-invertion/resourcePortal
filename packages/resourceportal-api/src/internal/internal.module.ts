import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { AuthSessionMaintenanceController } from "./auth-session-maintenance.controller";
import { DeploymentWorkerController } from "./deployment-worker.controller";
import { DeploymentWorkerService } from "./deployment-worker.service";
import { InternalAuthGuard } from "./internal-auth.guard";
import { RuntimeDriftReconcilerService } from "./runtime-drift-reconciler.service";
import { StackApplyService } from "./stack-apply.service";
import { StackConfigProvisionerService } from "./stack-config-provisioner.service";
import { StackRegistryAuthService } from "./stack-registry-auth.service";
import { StackRolloutService } from "./stack-rollout.service";
import { StackRuntimeService } from "./stack-runtime.service";
import { StackSecretProvisionerService } from "./stack-secret-provisioner.service";
import { StackVolumeProvisionerService } from "./stack-volume-provisioner.service";

@Module({
  imports: [AuthModule, PrismaModule, SecurityModule],
  controllers: [AuthSessionMaintenanceController, DeploymentWorkerController],
  providers: [
    DeploymentWorkerService,
    InternalAuthGuard,
    RuntimeDriftReconcilerService,
    StackApplyService,
    StackConfigProvisionerService,
    StackRegistryAuthService,
    StackRolloutService,
    StackRuntimeService,
    StackSecretProvisionerService,
    StackVolumeProvisionerService,
  ],
})
export class InternalModule {}
