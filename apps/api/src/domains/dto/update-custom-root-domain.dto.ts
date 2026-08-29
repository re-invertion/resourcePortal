import { IsIn, IsOptional, IsString } from "class-validator";

export class UpdateCustomRootDomainDto {
  @IsOptional()
  @IsString()
  @IsIn(["Pending", "Verified", "Invalid", "Error"])
  verificationStatus?: string;
}
