import {Type} from "class-transformer";
import {ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsIP, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateNested } from "class-validator";

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
export class GateLanAttachmentProofDto {
  @IsIn(["gate-agent"]) source!: "gate-agent";
  @IsUUID() attachmentId!:string;
  @IsUUID() tenantId!:string;
  @IsUUID() singleAppId!:string;
  @IsUUID() gateId!:string;
  @IsInt() @Min(1) configurationRevision!:number;
  @Matches(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i) macAddress!:string;
  @IsInt() @Min(1) observedAtMs!:number;
  @IsBoolean() gatewayTunnelOwned!:boolean;
  @IsBoolean() bridgeOwned!:boolean;
  @IsBoolean() macLearnedOnTunnel!:boolean;
  @IsInt() @Min(1) handshakeAtMs!:number;
}
export class GateL2DiagnosticDto {
  @IsIn(["ok","collector_error","peer_not_matched","no_local_attachment","tunnel_or_bridge_not_owned"])
  reasonCode!: "ok"|"collector_error"|"peer_not_matched"|"no_local_attachment"|"tunnel_or_bridge_not_owned";
  @IsInt() @Min(0) @Max(64) rawCount!:number;
  @IsOptional() @IsIn(["none","collector_execution_failed","invalid_collector_output"])
  errorCode?:"none"|"collector_execution_failed"|"invalid_collector_output";
}
export class GateHeartbeatDto {
  @IsIn(["gate-l2-v1", "gate-l2-v2"])
  agentVersion!: "gate-l2-v1" | "gate-l2-v2";

  @IsOptional() @ValidateNested() @Type(() => GateLanObservationDto)
  lanObservation?: GateLanObservationDto;

  @IsOptional() @IsArray() @ArrayMaxSize(64)
  @ValidateNested({each:true}) @Type(()=>GateLanAttachmentProofDto)
  lanAttachmentProofs?: GateLanAttachmentProofDto[];

  @IsOptional() @ValidateNested() @Type(() => GateL2DiagnosticDto)
  lanProofDiagnostic?:GateL2DiagnosticDto;

  @IsOptional() @IsInt() @Min(1)
  lanAppliedAtMs?:number;
}
