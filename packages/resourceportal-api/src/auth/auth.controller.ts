import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { Authenticated } from "./authenticated.decorator";
import { CurrentUser } from "./current-user.decorator";
import { Public } from "./public.decorator";
import { AuthenticatedUser } from "./types";
import { AuthFlowService } from "./auth-flow.service";
import { AuthSessionService } from "./auth-session.service";
import {
  LoginProvidersQueryDto,
  LoginQueryDto,
} from "./dto/login-query.dto";

const providerCookieName = "rp_oidc_provider";
const stateCookieName = "rp_oidc_state";
const verifierCookieName = "rp_oidc_verifier";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authFlow: AuthFlowService,
    private readonly sessions: AuthSessionService,
  ) {}

  @Public()
  @Get("providers")
  @ApiOperation({ summary: "List enabled identity providers for login" })
  @ApiOkResponse({
    description:
      "Returns platform and tenant identity providers allowed by the selected tenant policy.",
  })
  listProviders(@Query() query: LoginProvidersQueryDto) {
    return this.authFlow.listLoginOptions(query.tenantId);
  }

  @Public()
  @Get("login")
  @ApiOperation({
    summary: "Start OIDC login",
    description:
      "Redirects the browser to the configured OIDC provider and sets signed, httpOnly callback cookies.",
  })
  @ApiFoundResponse({
    description: "Redirects to the OIDC authorization endpoint.",
  })
  @ApiQuery({ name: "tenantId", required: false, type: String })
  @ApiQuery({ name: "identityProviderId", required: false, type: String })
  async login(@Query() query: LoginQueryDto, @Res() reply: FastifyReply) {
    const login = await this.authFlow.createLoginRequest(query);

    reply.setCookie(stateCookieName, login.state, {
      httpOnly: true,
      maxAge: 600,
      path: "/api/auth",
      sameSite: "lax",
      secure: this.sessions.isCookieSecure(),
      signed: true,
    });
    reply.setCookie(verifierCookieName, login.codeVerifier, {
      httpOnly: true,
      maxAge: 600,
      path: "/api/auth",
      sameSite: "lax",
      secure: this.sessions.isCookieSecure(),
      signed: true,
    });
    if (login.identityProviderId) {
      reply.setCookie(providerCookieName, login.identityProviderId, {
        httpOnly: true,
        maxAge: 600,
        path: "/api/auth",
        sameSite: "lax",
        secure: this.sessions.isCookieSecure(),
        signed: true,
      });
    } else {
      reply.clearCookie(providerCookieName, { path: "/api/auth" });
    }

    return reply.status(302).redirect(login.authorizationUrl);
  }

  @Public()
  @Get("callback")
  @ApiOperation({
    summary: "Complete OIDC login",
    description:
      "Validates signed callback cookies, exchanges the authorization code, creates a server-side session, and redirects to the app root.",
  })
  @ApiQuery({
    name: "code",
    required: true,
    description: "OIDC authorization code.",
  })
  @ApiQuery({
    name: "state",
    required: true,
    description: "OIDC state returned by the provider.",
  })
  @ApiFoundResponse({
    description: "Creates the session cookie and redirects to the app root.",
  })
  @ApiBadRequestResponse({
    description: "Missing callback code or state.",
  })
  @ApiUnauthorizedResponse({
    description: "Invalid state, verifier, or authorization code exchange.",
  })
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
      this.getSignedCookie(request, stateCookieName),
      this.getSignedCookie(request, verifierCookieName),
      this.getSignedCookie(request, providerCookieName),
    );

    reply.clearCookie(stateCookieName, {
      path: "/api/auth",
    });
    reply.clearCookie(verifierCookieName, {
      path: "/api/auth",
    });
    reply.clearCookie(providerCookieName, {
      path: "/api/auth",
    });
    reply.setCookie(this.sessions.getSessionCookieName(), result.session.id, {
      httpOnly: true,
      maxAge: this.sessions.getSessionMaxAgeSeconds(),
      path: "/",
      sameSite: "lax",
      secure: this.sessions.isCookieSecure(),
      signed: true,
    });
    reply.setCookie(
      this.sessions.getCsrfCookieName(),
      randomBytes(32).toString("base64url"),
      {
        httpOnly: false,
        maxAge: this.sessions.getSessionMaxAgeSeconds(),
        path: "/",
        sameSite: "lax",
        secure: this.sessions.isCookieSecure(),
        signed: false,
      },
    );

    return reply.status(302).redirect("/");
  }

  @Post("logout")
  @Authenticated()
  @ApiCookieAuth("rp_session")
  @ApiOperation({ summary: "Logout current local browser session" })
  @ApiNoContentResponse({
    description: "The current local session was revoked.",
  })
  async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    await this.sessions.revokeSession(
      this.sessions.getSessionIdFromRequest(request),
    );
    this.clearSessionCookies(reply);
    return reply.status(204).send();
  }

  @Post("logout/provider")
  @Authenticated()
  @ApiCookieAuth("rp_session")
  @ApiOperation({
    summary: "Revoke provider tokens and prepare RP-initiated OIDC logout",
  })
  @ApiOkResponse({
    description:
      "Returns the provider end-session URL. The browser should navigate to logoutUrl when it is non-null.",
  })
  async providerLogout(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.sessions.prepareProviderLogout(
      this.sessions.getSessionIdFromRequest(request),
    );
    this.clearSessionCookies(reply);
    return reply.status(200).send(result);
  }

  @Get("sessions")
  @Authenticated()
  @ApiCookieAuth("rp_session")
  @ApiOperation({ summary: "List active sessions for the current user" })
  @ApiOkResponse({
    description: "Active session metadata. Provider tokens are never returned.",
  })
  async activeSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ) {
    return this.sessions.listActiveSessions(
      user.id,
      this.sessions.getSessionIdFromRequest(request),
    );
  }

  @Get("me")
  @Authenticated()
  @ApiCookieAuth("rp_session")
  @ApiOperation({
    summary: "Get current authenticated user",
  })
  @ApiOkResponse({
    description: "Current authenticated user.",
  })
  @ApiUnauthorizedResponse({
    description: "Authentication is required.",
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  private clearSessionCookies(reply: FastifyReply) {
    reply.clearCookie(this.sessions.getSessionCookieName(), {
      path: "/",
    });
    reply.clearCookie(this.sessions.getCsrfCookieName(), {
      path: "/",
    });
  }

  private getSignedCookie(request: FastifyRequest, name: string) {
    const value = request.cookies[name];

    if (!value) {
      return undefined;
    }

    const unsigned = request.unsignCookie(value);

    if (!unsigned.valid) {
      return undefined;
    }

    return unsigned.value;
  }
}
