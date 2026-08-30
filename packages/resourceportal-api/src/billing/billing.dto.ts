import { Type } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from "class-validator";

const NON_NEGATIVE_DECIMAL = /^\d+(?:\.\d{1,8})?$/;
const POSITIVE_DECIMAL = /^(?=.*[1-9])\d+(?:\.\d{1,8})?$/;
const SIGNED_NON_ZERO_DECIMAL = /^-?(?=.*[1-9])\d+(?:\.\d{1,8})?$/;

export class CreatePriceListDto {
  @IsDateString()
  effectiveFrom!: string;

  @Matches(NON_NEGATIVE_DECIMAL)
  cpuCreditsPerVcpuHour!: string;

  @Matches(NON_NEGATIVE_DECIMAL)
  memoryCreditsPerGbHour!: string;

  @Matches(NON_NEGATIVE_DECIMAL)
  storageCreditsPerGbHour!: string;

  @Matches(NON_NEGATIVE_DECIMAL)
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

  @Matches(SIGNED_NON_ZERO_DECIMAL)
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

export class PlatformPaymentDto extends PlatformBalanceMutationDto {
  @Matches(POSITIVE_DECIMAL)
  declare amountCredits: string;
}

export class PlatformRefundDto extends PlatformPaymentDto {
  @IsString()
  @IsNotEmpty()
  declare reason: string;
}

export class PlatformCorrectionDto extends PlatformBalanceMutationDto {
  @IsString()
  @IsNotEmpty()
  declare reason: string;
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
  @IsIn(["SingleApp", "Volume"])
  resourceType?: string;

  @IsOptional()
  @IsUUID()
  resourceId?: string;

  @IsOptional()
  @IsUUID()
  appGroupId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
