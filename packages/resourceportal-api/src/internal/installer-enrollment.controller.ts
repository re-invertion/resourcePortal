import { Body, Controller, Post } from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional, IsString, Matches } from "class-validator";
import {
  InstallerEnrollmentBundleRole,
  InstallerEnrollmentService,
} from "./installer-enrollment.service";
import { InstallerEnrollmentNodeLabelService } from "./installer-enrollment-node-label.service";

class RedeemInstallerEnrollmentDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{40,}$/)
  token!: string;

  @IsIn(["worker", "manager"])
  role!: InstallerEnrollmentBundleRole;
}

class CompleteInstallerEnrollmentDto extends RedeemInstallerEnrollmentDto {
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

@Controller("installer/enrollment")
export class InstallerEnrollmentController {
  constructor(
    private readonly enrollment: InstallerEnrollmentService,
    private readonly nodeLabels: InstallerEnrollmentNodeLabelService,
  ) {}

  @Post("redeem")
  redeem(@Body() dto: RedeemInstallerEnrollmentDto) {
    return this.enrollment.redeem(dto.token, dto.role);
  }

  @Post("complete")
  async complete(@Body() dto: CompleteInstallerEnrollmentDto) {
    const claim = await this.enrollment.claimCompletion(dto.token, dto.role, dto.nodeId);
    try {
      await this.nodeLabels.apply(dto.nodeId, dto.role, dto.controlPlane, dto.ingress);
      return { status: "completed", role: dto.role };
    } catch (error) {
      await this.enrollment.releaseCompletionClaim(
        dto.token, dto.role, dto.nodeId, claim.completedAt,
      );
      throw error;
    }
  }
}
