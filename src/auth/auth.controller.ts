import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { FastifyReply, FastifyRequest } from "fastify";
import { CurrentUser } from "./current-user.decorator";
import { Public } from "./public.decorator";
import { AuthenticatedUser } from "./types";
import { AuthFlowService } from "./auth-flow.service";
import { AuthSessionService } from "./auth-session.service";

const stateCookieName = "rp_oidc_state";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authFlow: AuthFlowService,
    private readonly sessions: AuthSessionService,
  ) {}

  @Public()
  @Get("login")
  async login(@Res() reply: FastifyReply) {
    const login = await this.authFlow.createLoginRequest();

    reply.setCookie(stateCookieName, login.state, {
      httpOnly: true,
      maxAge: 600,
      path: "/api/auth",
      sameSite: "lax",
      secure: this.sessions.isCookieSecure(),
    });
    reply.setCookie("rp_oidc_verifier", login.codeVerifier, {
      httpOnly: true,
      maxAge: 600,
      path: "/api/auth",
      sameSite: "lax",
      secure: this.sessions.isCookieSecure(),
    });

    return reply.status(302).redirect(login.authorizationUrl);
  }

  @Public()
  @Get("callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    if (!code || !state) {
      throw new BadRequestException("OIDC callback code and state are required");
    }

    const result = await this.authFlow.handleCallback(
      code,
      state,
      request.cookies[stateCookieName],
      request.cookies.rp_oidc_verifier,
    );

    reply.clearCookie(stateCookieName, {
      path: "/api/auth",
    });
    reply.clearCookie("rp_oidc_verifier", {
      path: "/api/auth",
    });
    reply.setCookie(this.sessions.getSessionCookieName(), result.session.id, {
      httpOnly: true,
      maxAge: this.sessions.getSessionMaxAgeSeconds(),
      path: "/",
      sameSite: "lax",
      secure: this.sessions.isCookieSecure(),
    });

    return reply.status(302).redirect("/");
  }

  @Post("logout")
  async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    await this.sessions.revokeSession(
      request.cookies[this.sessions.getSessionCookieName()],
    );
    reply.clearCookie(this.sessions.getSessionCookieName(), {
      path: "/",
    });

    return reply.status(204).send();
  }

  @Get("me")
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
