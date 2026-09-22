import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { CloudflareDnsService } from "./cloudflare-dns.service";
import { CloudflareOauthController } from "./cloudflare-oauth.controller";
import { CloudflareTenantOauthService } from "./cloudflare-tenant-oauth.service";
import { ManagedDnsService } from "./managed-dns.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  controllers: [CloudflareOauthController],
  providers: [CloudflareDnsService, ManagedDnsService, CloudflareTenantOauthService],
  exports: [ManagedDnsService, CloudflareTenantOauthService],
})
export class PlatformDnsModule {}
