import {Type} from "class-transformer";
import {ArrayUnique, IsArray, IsIn, IsInt, IsIP, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateNested } from "class-validator";

export class GateLanObservationDto {
  @IsIn([1]) protocol!: 1;
  @IsUUID() gateId!: string;
  @IsString() @Matches(/^[0-9a-f]{24}$/) segmentId!: string;
  @IsString() @Matches(/^[a-zA-Z][a-zA-Z0-9_.-]{0,14}$/) physicalInterface!: string;
  @IsString() @Matches(/^rp-gb-[0-9a-f]{8}$/) bridge!: string;
  @IsString() @Matches(/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/) networkCidr!: string;
  @IsString() @Matches(/^(?:\d{1,3}\.){3}\d{1,3}$/) @IsIP(4) gateway!: string;
  @IsInt() @Min(16) @Max(30) prefix!:number;
  @IsString() @Matches(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/) @IsIP(4) netmask!:string;
  @IsArray() @ArrayUnique() @IsIn(["ManagedSharedUplink","LANDiscoveryV1"],{each:true})
  capabilities!:Array<"ManagedSharedUplink"|"LANDiscoveryV1">;
  @IsIn(["host-verified"]) discoveryMethod!: "host-verified";
  @IsISO8601() observedAt!: string;
  @IsIn(["gate-l2-v2"]) agentVersion!: "gate-l2-v2";
  @IsIn(["Ready"]) state!: "Ready";
}
export class GateHeartbeatDto {
  @IsIn(["gate-l2-v1", "gate-l2-v2"])
  agentVersion!: "gate-l2-v1" | "gate-l2-v2";

  @IsOptional() @ValidateNested() @Type(() => GateLanObservationDto)
  lanObservation?: GateLanObservationDto;
}
