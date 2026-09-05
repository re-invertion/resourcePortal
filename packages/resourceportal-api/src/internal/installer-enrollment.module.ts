import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { InstallerEnrollmentController } from "./installer-enrollment.controller";
import { validateInstallerEnrollmentEnv } from "./installer-enrollment.env";
import { InstallerEnrollmentService } from "./installer-enrollment.service";

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
  providers: [InstallerEnrollmentService],
  exports: [InstallerEnrollmentService],
})
export class InstallerEnrollmentModule {}
