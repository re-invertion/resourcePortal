import { Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";

/** Bounded, tenant-scoped Docker service logs. Never accepts a service name from the caller. */
@Injectable()
export class SingleAppLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async list(tenantId: string, appGroupId: string, singleAppId: string) {
    const singleApp = await this.prisma.singleApp.findFirst({
      where: { id: singleAppId, appGroupId, appGroup: { tenantId } },
      select: { name: true },
    });
    if (!singleApp) throw new NotFoundException("Application not found");

    const service = `rp_${appGroupId.replaceAll("-", "_")}_${singleApp.name.replaceAll("-", "_")}`;
    const token = this.config.get<string>("INTERNAL_WORKER_TOKEN");
    if (!token) throw new ServiceUnavailableException("Container logs are currently unavailable");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch("http://worker:3101/internal/single-app-logs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": token },
        body: JSON.stringify({ service }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Worker log request failed");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("lines" in result) ||
          !Array.isArray(result.lines) || !result.lines.every((line) => typeof line === "string")) {
        throw new Error("Invalid worker response");
      }
      return { lines: result.lines.join("\n").slice(-65536).split("\n").filter(Boolean), serviceAvailable: true };
    } catch {
      throw new ServiceUnavailableException("Container logs are currently unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }
}
