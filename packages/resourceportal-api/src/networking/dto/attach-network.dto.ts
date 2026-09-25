import { IsIP, IsInt, IsOptional, IsUUID, Min } from "class-validator";

export class AttachNetworkDto {
  @IsUUID()
  singleAppId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;

  @IsOptional()
  @IsIP(4)
  address?: string;
}
