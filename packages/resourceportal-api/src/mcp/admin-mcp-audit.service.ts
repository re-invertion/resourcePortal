import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AdminMcpAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async recordToolCall(input: {
    actor: AuthenticatedUser;
    toolName: string;
    method?: string;
    path?: string;
    statusCode?: number;
    success: boolean;
    requestId?: string;
    correlationId?: string;
  }) {
    try {
      await this.prisma.auditLogEntry.create({
        data: {
          tenantId: null,
          tenantName: "ResourcePortal Platform",
          actor: input.actor.id,
          actorName: input.actor.displayName,
          action: "platform.mcp.tool.call",
          resourceType: "AdminMcp",
          resourceId: null,
          result: input.success ? "Success" : "Failure",
          errorCode: input.success ? null : "ADMIN_MCP_TOOL_CALL_FAILED",
          requestId: input.requestId,
          correlationId: input.correlationId ?? randomUUID(),
          changes: {
            toolName: input.toolName,
            method: input.method ?? null,
            path: input.path ?? null,
            statusCode: input.statusCode ?? null,
          },
        },
      });
    } catch {
      // Admin MCP audit logging must never change the tool result.
    }
  }
}
