import { Type } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from "class-validator";

const POSITIVE_DECIMAL = /^\d+(?:\.\d{1,8})?$/;
const SIGNED_DECIMAL = /^-?\d+(?:\.\d{1,8})?$/;

export class CreatePriceListDto {
  @IsDateString()
  effectiveFrom!: string;

  @Matches(POSITIVE_DECIMAL)
  cpuCreditsPerVcpuHour!: string;

  @Matches(POSITIVE_DECIMAL)
  memoryCreditsPerGbHour!: string;

  @Matches(POSITIVE_DECIMAL)
  storageCreditsPerGbHour!: string;

  @Matches(POSITIVE_DECIMAL)
  gpuCreditsPerGpuHour!: string;
}

export class CreateVoucherDto {
  @Matches(POSITIVE_DECIMAL)
  valueCredits!: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class RedeemVoucherDto {
  @IsString()
  @Matches(/^RPV-[A-F0-9]{48}$/)
  code!: string;
}

export class PlatformBalanceMutationDto {
  @IsUUID()
  tenantId!: string;

  @Matches(SIGNED_DECIMAL)
  amountCredits!: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsUUID()
  sourceTransactionId?: string;
}

export class BillingHistoryQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @IsOptional()
  @IsIn(["TopUp", "VoucherRedeem", "Payment", "UsageCharge", "Refund", "Correction"])
  type?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class UsageHistoryQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @IsOptional()
  @IsString()
  resourceType?: string;

  @IsOptional()
  @IsUUID()
  resourceId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
