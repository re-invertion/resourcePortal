import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches } from "class-validator";

/** The remote NIC must be a dedicated Ethernet-facing interface. */
export class CreateRemoteLanAttachmentDto {
  @IsUUID() singleAppId!: string;
  @IsUUID() networkId!: string;
  @IsUUID() gateId!: string;
  @IsString() @IsNotEmpty()
  @Matches(/^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/)
  lanInterface!: string;
  @IsString() @Matches(/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/)
  lanCidr!: string;
  @IsOptional() @IsIn(["DedicatedUnnumbered","ManagedSharedUplink"])
  uplinkMode?: "DedicatedUnnumbered" | "ManagedSharedUplink";
  @IsOptional() @IsIn(["DHCP","Static"])
  addressMode?: "DHCP" | "Static";
  @IsOptional() @IsString()
  @Matches(/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/)
  staticAddress?: string;
  @IsOptional() @IsString()
  @Matches(/^(?:\d{1,3}\.){3}\d{1,3}$/)
  staticGateway?: string;
}
