import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsUUID,
} from "class-validator";

export const tenantMcpAccessModes = ["AllMembers", "SelectedMembers"] as const;
export type TenantMcpAccessMode = (typeof tenantMcpAccessModes)[number];

export class UpdateTenantMcpSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(tenantMcpAccessModes)
  accessMode?: TenantMcpAccessMode;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID("4", { each: true })
  allowedMembershipIds?: string[];
}
