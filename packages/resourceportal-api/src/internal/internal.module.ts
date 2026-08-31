import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CapacityModule } from "../capacity/capacity.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { AuthSessionMaintenanceController } from "./auth-session-maintenance.controller";
import { DeploymentAuditService } from "./deployment-audit.service";
import { DeploymentRecoveryService } from "./deployment-recovery.service";
import { DeploymentWorkerController } from "./deployment-worker.controller";
import { DeploymentWorkerService } from "./deployment-worker.service";
import { DomainCertificateReconcilerService } from "./domain-certificate-reconciler.service";
import { IngressReconcilerService } from "./ingress-reconciler.service";
import { InternalAuthGuard } from "./internal-auth.guard";
import { RuntimeDriftReconcilerService } from "./runtime-drift-reconciler.service";
import { StackApplyService } from "./stack-apply.service";
import { StackConfigProvisionerService } from "./stack-config-provisioner.service";
import { StackRegistryAuthService } from "./stack-registry-auth.service";
import { StackRolloutService } from "./stack-rollout.service";
import { StackRuntimeService } from "./stack-runtime.service";
import { StackSecretProvisionerService } from "./stack-secret-provisioner.service";
import { StackVolumeProvisionerService } from "./stack-volume-provisioner.service";
import { TraefikCertificateObserverService } from "./traefik-certificate-observer.service";

@Module({
  imports: [AuthModule, CapacityModule, PrismaModule, SecurityModule],
  controllers: [AuthSessionMaintenanceController, DeploymentWorkerController],
  providers: [
    DeploymentAuditService,
    DeploymentRecoveryService,
    DeploymentWorkerService,
    DomainCertificateReconcilerService,
    IngressReconcilerService,
    InternalAuthGuard,
    RuntimeDriftReconcilerService,
    StackApplyService,
    StackConfigProvisionerService,
    StackRegistryAuthService,
    StackRolloutService,
    StackRuntimeService,
    StackSecretProvisionerService,
    StackVolumeProvisionerService,
    TraefikCertificateObserverService,
  ],
})
export class InternalModule {}
