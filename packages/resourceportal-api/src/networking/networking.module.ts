import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { NetworkingService } from "./networking.service";
import { RemoteLanAttachmentService } from "./remote-lan-attachment.service";
import { WireGuardKeyService } from "./wireguard-key.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  providers: [NetworkingService, WireGuardKeyService, RemoteLanAttachmentService],
  exports: [NetworkingService, WireGuardKeyService, RemoteLanAttachmentService],
})
export class NetworkingModule {}
