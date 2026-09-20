import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches } from "class-validator";
import {
  InstallerEnrollmentBundleRole,
  InstallerEnrollmentService,
} from "./installer-enrollment.service";

class RedeemInstallerEnrollmentDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{40,}$/)
  token!: string;

  @IsIn(["worker", "manager"])
  role!: InstallerEnrollmentBundleRole;

  @IsString()
  publicKey!: string;
}

class EnrollmentStatusDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{40,}$/)
  token!: string;

  @IsIn(["worker", "manager"])
  role!: InstallerEnrollmentBundleRole;

  @IsUUID()
  operationId!: string;
}

class CompleteInstallerEnrollmentDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{40,}$/)
  token!: string;

  @IsIn(["worker", "manager"])
  role!: InstallerEnrollmentBundleRole;

  @IsString()
  @Matches(/^[a-zA-Z0-9]{20,64}$/)
  nodeId!: string;

  @IsOptional()
  @IsBoolean()
  controlPlane = false;

  @IsOptional()
  @IsBoolean()
  ingress = false;
}

class CompleteInstallerEnrollmentStatusDto extends EnrollmentStatusDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9]{20,64}$/)
  nodeId!: string;
}

@Controller("installer/enrollment")
export class InstallerEnrollmentController {
  constructor(private readonly enrollment: InstallerEnrollmentService) {}

  @Post("redeem")
  @HttpCode(HttpStatus.ACCEPTED)
  redeem(@Body() dto: RedeemInstallerEnrollmentDto) {
    return this.enrollment.beginRedemption(dto.token, dto.role, dto.publicKey);
  }

  @Post("redeem/status")
  @HttpCode(HttpStatus.OK)
  redemptionStatus(@Body() dto: EnrollmentStatusDto) {
    return this.enrollment.redemptionStatus(dto.token, dto.role, dto.operationId);
  }

  @Post("complete")
  @HttpCode(HttpStatus.ACCEPTED)
  complete(@Body() dto: CompleteInstallerEnrollmentDto) {
    return this.enrollment.beginCompletion(
      dto.token,
      dto.role,
      dto.nodeId,
      dto.controlPlane,
      dto.ingress,
    );
  }

  @Post("complete/status")
  @HttpCode(HttpStatus.OK)
  completionStatus(@Body() dto: CompleteInstallerEnrollmentStatusDto) {
    return this.enrollment.completionStatus(
      dto.token,
      dto.role,
      dto.nodeId,
      dto.operationId,
    );
  }
}
