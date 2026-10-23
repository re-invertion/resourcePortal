import { Module } from "@nestjs/common";
import { OperationsModule } from "../operations/operations.module";
import {
  DeviceVpnRuntimeController,
  GateAgentController,
  NetworkingController,
} from "./networking.controller";
import { NetworkingModule } from "./networking.module";
import { RemoteLanAttachmentController } from "./remote-lan-attachment.controller";

@Module({
  imports: [NetworkingModule, OperationsModule],
  controllers: [NetworkingController, GateAgentController, DeviceVpnRuntimeController, RemoteLanAttachmentController],
})
export class NetworkingApiModule {}
