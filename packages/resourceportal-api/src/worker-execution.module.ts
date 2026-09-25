import { Module } from "@nestjs/common";
import { CapacityModule } from "./capacity/capacity.module";
import { DomainsModule } from "./domains/domains.module";
import { DeploymentAuditService } from "./internal/deployment-audit.service";
import { DeploymentRecoveryService } from "./internal/deployment-recovery.service";
import { DeploymentExecutionService } from "./internal/deployment-execution.service";
import { DomainCertificateReconcilerService } from "./internal/domain-certificate-reconciler.service";
import { IngressReconcilerService } from "./internal/ingress-reconciler.service";
import { InstallerEnrollmentNodeLabelService } from "./internal/installer-enrollment-node-label.service";
import { RuntimeDriftReconcilerService } from "./internal/runtime-drift-reconciler.service";
import { StackApplyService } from "./internal/stack-apply.service";
import { StackConfigProvisionerService } from "./internal/stack-config-provisioner.service";
import { StackRegistryAuthService } from "./internal/stack-registry-auth.service";
import { StackRolloutService } from "./internal/stack-rollout.service";
import { StackRuntimeService } from "./internal/stack-runtime.service";
import { StackSecretProvisionerService } from "./internal/stack-secret-provisioner.service";
import { StackVolumeProvisionerService } from "./internal/stack-volume-provisioner.service";
import { TraefikCertificateObserverService } from "./internal/traefik-certificate-observer.service";
import { DeploymentOperationExecutor } from "./operations/executors/deployment-operation.executor";
import { DomainOperationExecutor } from "./operations/executors/domain-operation.executors";
import { InfrastructureOperationExecutor } from "./operations/executors/infrastructure-operation.executor";
import { InstallerEnrollmentOperationExecutor } from "./operations/executors/installer-enrollment-operation.executor";
import { RuntimeOperationExecutor } from "./operations/executors/runtime-operation.executor";
import { VolumeOperationExecutor } from "./operations/executors/volume-operation.executors";
import { NetworkTopologyOperationExecutor } from "./operations/executors/network-topology-operation.executor";
import { GateRuntimeReconcilerService } from "./networking/gate-runtime-reconciler.service";
import { NetworkingModule } from "./networking/networking.module";
import { OperationExecutorRegistry } from "./operations/operation-executor-registry";
import { OperationsModule } from "./operations/operations.module";
import { OperationsWorkerService } from "./operations/operations-worker.service";
import { PlatformInfrastructureModule } from "./platform-infrastructure/platform-infrastructure.module";
import { PlatformMaintenanceModule } from "./platform-maintenance/platform-maintenance.module";
import { PrismaModule } from "./prisma/prisma.module";
import { SecurityModule } from "./security/security.module";
import { StorageBackendsModule } from "./storage-backends/storage-backends.module";
import { VolumesModule } from "./volumes/volumes.module";

@Module({
  imports: [
    CapacityModule,
    DomainsModule,
    OperationsModule,
    PlatformInfrastructureModule,
    PlatformMaintenanceModule,
    NetworkingModule,
    PrismaModule,
    SecurityModule,
    StorageBackendsModule,
    VolumesModule,
  ],
  providers: [
    DeploymentAuditService,
    DeploymentOperationExecutor,
    DeploymentRecoveryService,
    DeploymentExecutionService,
    DomainCertificateReconcilerService,
    DomainOperationExecutor,
    IngressReconcilerService,
    GateRuntimeReconcilerService,
    InstallerEnrollmentNodeLabelService,
    InfrastructureOperationExecutor,
    InstallerEnrollmentOperationExecutor,
    NetworkTopologyOperationExecutor,
    OperationsWorkerService,
    RuntimeDriftReconcilerService,
    RuntimeOperationExecutor,
    StackApplyService,
    StackConfigProvisionerService,
    StackRegistryAuthService,
    StackRolloutService,
    StackRuntimeService,
    StackSecretProvisionerService,
    StackVolumeProvisionerService,
    TraefikCertificateObserverService,
    VolumeOperationExecutor,
    {
      provide: OperationExecutorRegistry,
      useFactory: (
        deploymentExecutor: DeploymentOperationExecutor,
        infrastructureExecutor: InfrastructureOperationExecutor,
        installerEnrollmentExecutor: InstallerEnrollmentOperationExecutor,
        runtimeExecutor: RuntimeOperationExecutor,
        volumeExecutor: VolumeOperationExecutor,
        domainExecutor: DomainOperationExecutor,
        networkTopologyExecutor: NetworkTopologyOperationExecutor,
      ) =>
        new OperationExecutorRegistry([
          deploymentExecutor,
          infrastructureExecutor,
          installerEnrollmentExecutor,
          runtimeExecutor,
          volumeExecutor,
          domainExecutor,
          networkTopologyExecutor,
        ]),
      inject: [
        DeploymentOperationExecutor,
        InfrastructureOperationExecutor,
        InstallerEnrollmentOperationExecutor,
        RuntimeOperationExecutor,
        VolumeOperationExecutor,
        DomainOperationExecutor,
        NetworkTopologyOperationExecutor,
      ],
    },
  ],
  exports: [
    DeploymentExecutionService,
    DomainCertificateReconcilerService,
    IngressReconcilerService,
    GateRuntimeReconcilerService,
    OperationsWorkerService,
    RuntimeDriftReconcilerService,
    StackApplyService,
  ],
})
export class WorkerExecutionModule {}
