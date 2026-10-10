import { Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageCommandRunnerService } from "../storage-backends/storage-command-runner.service";

/** Bounded, tenant-scoped Docker service logs. Never accepts a service name from the caller. */
@Injectable()
export class SingleAppLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: StorageCommandRunnerService,
  ) {}

  async list(tenantId: string, appGroupId: string, singleAppId: string) {
    const singleApp = await this.prisma.singleApp.findFirst({
      where: { id: singleAppId, appGroupId, appGroup: { tenantId } },
      select: { name: true },
    });
    if (!singleApp) throw new NotFoundException("Application not found");

    const service = `rp_${appGroupId.replaceAll("-", "_")}_${singleApp.name.replaceAll("-", "_")}`;
    const result = await this.runner.run(
      "docker",
      ["service", "logs", "--timestamps", "--tail", "100", service],
      15_000,
    );
    if (result.exitCode !== 0) {
      throw new ServiceUnavailableException("Container logs are currently unavailable");
    }
    // Bound response size independently of the log volume and exclude Docker stderr.
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return { lines: output.slice(-65536).split("\n").filter(Boolean), serviceAvailable: true };
  }
}
