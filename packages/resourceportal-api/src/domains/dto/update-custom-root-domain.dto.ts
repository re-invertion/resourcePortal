import { CustomRootDomainVerificationStatus } from "@prisma/client";
import { IsIn, IsOptional } from "class-validator";

export class UpdateCustomRootDomainDto {
  @IsOptional()
  @IsIn([
    CustomRootDomainVerificationStatus.Pending,
    CustomRootDomainVerificationStatus.Failed,
  ])
  verificationStatus?: CustomRootDomainVerificationStatus;
}
