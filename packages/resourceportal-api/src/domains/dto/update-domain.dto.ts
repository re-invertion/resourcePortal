import { IsBoolean, IsOptional, IsUUID } from "class-validator";

export class UpdateDomainDto {
  /** Legacy custom domains may be linked only to a verified, tenant-owned root. */
  @IsOptional()
  @IsUUID()
  customRootDomainId?: string;

  @IsOptional()
  @IsUUID()
  httpEndpointId?: string | null;

  @IsOptional()
  @IsBoolean()
  tlsEnabled?: boolean;
}
