import { Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { AuthSessionService } from "../auth/auth-session.service";
import { Public } from "../auth/public.decorator";
import { InternalAuthGuard } from "./internal-auth.guard";

@ApiTags("internal-auth")
@Public()
@UseGuards(InternalAuthGuard)
@Controller("internal/auth/sessions")
export class AuthSessionMaintenanceController {
  constructor(private readonly sessions: AuthSessionService) {}

  @Post("prune")
  @ApiOperation({
    summary: "Revoke expired browser sessions",
  })
  @ApiOkResponse({
    description: "Expired sessions were marked as revoked.",
  })
  @ApiUnauthorizedResponse({
    description: "A valid internal worker token is required.",
  })
  @HttpCode(200)
  pruneExpiredSessions() {
    return this.sessions.pruneExpiredSessions();
  }
}
