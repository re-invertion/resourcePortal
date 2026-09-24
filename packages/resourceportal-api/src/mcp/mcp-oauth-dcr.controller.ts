import { Body, Controller, Post, Req, Res } from "@nestjs/common";
import { FastifyReply, FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator";
import { AllowDuringPlatformMaintenance } from "../platform-maintenance/allow-during-platform-maintenance.decorator";
import { McpOAuthDcrService } from "./mcp-oauth-dcr.service";

@Public()
@AllowDuringPlatformMaintenance()
@Controller("oauth/v2/register")
export class McpOAuthDcrController {
  constructor(private readonly dcr: McpOAuthDcrService) {}

  @Post()
  async register(
    @Body() metadata: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.dcr.register(metadata, request.headers.authorization);
    reply.status(result.status);
    reply.header("content-type", result.contentType);
    return reply.send(result.body);
  }
}
