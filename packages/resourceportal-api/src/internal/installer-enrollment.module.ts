import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { InstallerEnrollmentController } from "./installer-enrollment.controller";
import { validateInstallerEnrollmentEnv } from "./installer-enrollment.env";
import { InstallerEnrollmentService } from "./installer-enrollment.service";
import { InstallerEnrollmentNodeLabelService } from "./installer-enrollment-node-label.service";
import { StorageCommandRunnerService } from "../storage-backends/storage-command-runner.service";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      validate: validateInstallerEnrollmentEnv,
    }),
    PrismaModule,
  ],
  controllers: [InstallerEnrollmentController],
  providers: [InstallerEnrollmentService, InstallerEnrollmentNodeLabelService, StorageCommandRunnerService],
  exports: [InstallerEnrollmentService],
})
export class InstallerEnrollmentModule {}
