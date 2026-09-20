import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { CloudflareDnsService } from "./cloudflare-dns.service";
import { ManagedDnsService } from "./managed-dns.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  providers: [CloudflareDnsService, ManagedDnsService],
  exports: [ManagedDnsService],
})
export class PlatformDnsModule {}
