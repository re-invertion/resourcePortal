import { CustomRootDomainVerificationStatus } from "@prisma/client";
import { IsEnum, IsOptional } from "class-validator";

export class UpdateCustomRootDomainDto {
  @IsOptional()
  @IsEnum(CustomRootDomainVerificationStatus)
  verificationStatus?: CustomRootDomainVerificationStatus;
}
