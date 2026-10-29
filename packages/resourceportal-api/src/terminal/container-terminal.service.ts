import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";

export type TerminalAction = "containers" | "start" | "read" | "write" | "close" | "resize" | "execute";

@Injectable()
export class ContainerTerminalService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  async call(tenantId: string, appGroupId: string, singleAppId: string, actor: AuthenticatedUser, action: TerminalAction, body: Record<string, unknown> = {}) {
    const app = await this.prisma.singleApp.findFirst({
      where: { id: singleAppId, appGroupId, appGroup: { tenantId } },
      select: { name: true },
    });
    if (!app) throw new NotFoundException("Application not found");
    if (!/^[a-zA-Z0-9_-]+$/.test(app.name)) throw new BadRequestException("Application name is not a supported Docker service name");
    const service = `rp_${appGroupId.replaceAll("-", "_")}_${app.name.replaceAll("-", "_")}`;
    const token = this.config.get<string>("INTERNAL_WORKER_TOKEN");
    if (!token) throw new ServiceUnavailableException("Terminal worker authentication unavailable");
    if (!["containers", "start", "read", "write", "close", "resize", "execute"].includes(action)) throw new BadRequestException("Unsupported terminal action");
    const payload: Record<string, unknown> = {
      service,
      action,
      actor: createHmac("sha256", token).update(`${tenantId}:${appGroupId}:${singleAppId}:${actor.id}`).digest("hex"),
    };
    if (action === "start" || action === "execute") {
      if (body.container !== undefined && (typeof body.container !== "string" || !/^[a-f0-9]{12,64}$/.test(body.container))) throw new BadRequestException("Invalid container ID");
      payload.container = body.container;
    }
    if (["read", "write", "close", "resize"].includes(action)) {
      if (typeof body.sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(body.sessionId)) throw new BadRequestException("Invalid session ID");
      payload.sessionId = body.sessionId;
      if (action === "read" && body.cursor !== undefined) {
        if (!Number.isSafeInteger(body.cursor) || Number(body.cursor) < 0) throw new BadRequestException("Invalid terminal cursor");
        payload.cursor = body.cursor;
      }
    }
    if (action === "write") {
      if (typeof body.input !== "string" || Buffer.byteLength(body.input) > 8192) throw new BadRequestException("Terminal input exceeds 8 KiB");
      payload.input = body.input;
    }
    if (action === "resize") {
      if (!Number.isInteger(body.cols) || !Number.isInteger(body.rows) || Number(body.cols) < 20 || Number(body.cols) > 300 || Number(body.rows) < 5 || Number(body.rows) > 120) throw new BadRequestException("Invalid terminal dimensions");
      payload.cols = body.cols;
      payload.rows = body.rows;
    }
    if (action === "execute") {
      if (typeof body.command !== "string" || !body.command.trim() || Buffer.byteLength(body.command) > 4096) throw new BadRequestException("Command must contain 1–4096 bytes");
      payload.command = body.command;
    }
    const workerOrigin = this.config.get<string>("INTERNAL_LOG_WORKER_URL") ??
      (process.env.NODE_ENV === "production" ? "http://worker:3101" : "http://127.0.0.1:3101");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), action === "execute" ? 20_000 : 10_000);
    let result: unknown;
    try {
      const response = await fetch(`${workerOrigin}/internal/container-terminal`, {
        method: "POST", headers: { "content-type": "application/json", "x-internal-token": token },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      result = await response.json();
      if (!response.ok) {
        const message = result && typeof result === "object" && "message" in result && typeof result.message === "string"
          ? result.message : "Container terminal unavailable";
        if (response.status === 422) throw new BadRequestException(message);
        throw new Error("Worker returned an unexpected terminal response");
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException("Container terminal is currently unavailable");
    } finally { clearTimeout(timeout); }

    if (action === "start" || action === "execute" || action === "close") {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      // Store metadata only: never persist shell keystrokes, output, or commands.
      await this.prisma.auditLogEntry.create({ data: {
        tenantId, tenantName: tenant?.name ?? "Tenant", actor: actor.id,
        actorName: actor.displayName, action: `singleapp.terminal.${action}`,
        resourceType: "SingleApp", resourceId: singleAppId, resourceName: app.name,
        result: action === "execute" && result && typeof result === "object" && "status" in result && result.status !== "completed" ? "Failed" : "Success", changes: { appGroupId, sessionId: action === "execute" ? null : String(result && typeof result === "object" && "sessionId" in result ? result.sessionId : (body.sessionId ?? "")), container: String(result && typeof result === "object" && "container" in result ? result.container : (body.container ?? "")) },
      } });
    }
    return result;
  }
}
