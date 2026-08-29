import { IsBoolean, IsOptional, IsUUID } from "class-validator";

export class UpdateDomainDto {
  @IsOptional()
  @IsUUID()
  httpEndpointId?: string | null;

  @IsOptional()
  @IsBoolean()
  tlsEnabled?: boolean;
}
