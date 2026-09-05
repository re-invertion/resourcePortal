import { Body, Controller, Post } from "@nestjs/common";
import { IsIn, IsString, Matches } from "class-validator";
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
}

@Controller("installer/enrollment")
export class InstallerEnrollmentController {
  constructor(private readonly enrollment: InstallerEnrollmentService) {}

  @Post("redeem")
  redeem(@Body() dto: RedeemInstallerEnrollmentDto) {
    return this.enrollment.redeem(dto.token, dto.role);
  }
}
