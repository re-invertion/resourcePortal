import { IsIn } from "class-validator";

export class GateHeartbeatDto {
  @IsIn(["gate-l2-v1"])
  agentVersion!: "gate-l2-v1";
}
