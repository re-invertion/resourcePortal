import { IsIn, IsString, MaxLength } from "class-validator";

export class GateEnrollDto {
  @IsString()
  @MaxLength(256)
  token!: string;

  @IsString()
  @MaxLength(128)
  publicKey!: string;

  @IsIn(["gate-l2-v1", "gate-l2-v2"])
  agentVersion!: "gate-l2-v1" | "gate-l2-v2";
}
