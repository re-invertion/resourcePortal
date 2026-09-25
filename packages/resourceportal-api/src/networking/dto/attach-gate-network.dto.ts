import { IsInt, IsOptional, IsUUID, Min } from "class-validator";

export class AttachGateNetworkDto {
  @IsUUID()
  networkId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
