import { randomBytes } from "node:crypto";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuthenticatedUser } from "./types";
import { TokenResponse } from "./auth-flow.service";

@Injectable()
export class AuthSessionService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async createSession(userId: string, tokens: TokenResponse) {
    const now = Date.now();
    const accessTokenTtlSeconds = tokens.expires_in ?? 3600;
    const sessionTtlSeconds = this.getSessionTtlSeconds(accessTokenTtlSeconds);
    const expiresAt = new Date(now + sessionTtlSeconds * 1000);

    return this.prisma.portalSession.create({
      data: {
        id: randomBytes(32).toString("base64url"),
        userId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
        idToken: tokens.id_token,
        accessTokenExpiresAt: new Date(now + accessTokenTtlSeconds * 1000),
        expiresAt,
      },
      select: {
        id: true,
        expiresAt: true,
      },
    });
  }

  async authenticateSession(sessionId: string): Promise<AuthenticatedUser> {
    const session = await this.prisma.portalSession.findUnique({
      where: {
        id: sessionId,
      },
      include: {
        user: true,
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.user.status !== UserStatus.Active
    ) {
      throw new UnauthorizedException("Session is invalid");
    }

    await this.prisma.portalSession.update({
      where: {
        id: session.id,
      },
      data: {
        lastSeenAt: new Date(),
      },
    });

    return {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      status: session.user.status,
    };
  }

  async revokeSession(sessionId: string | undefined) {
    if (!sessionId) {
      return;
    }

    await this.prisma.portalSession.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  getSessionCookieName() {
    return this.config.get<string>("AUTH_SESSION_COOKIE_NAME", "rp_session");
  }

  getSessionMaxAgeSeconds() {
    return this.getSessionTtlSeconds(3600);
  }

  isCookieSecure() {
    return (
      this.config.get<string>("AUTH_COOKIE_SECURE") === "true" ||
      this.config.get<string>("NODE_ENV") === "production"
    );
  }

  private getSessionTtlSeconds(accessTokenTtlSeconds: number) {
    const configuredTtlSeconds = Number.parseInt(
      this.config.get<string>(
        "AUTH_SESSION_TTL_SECONDS",
        `${accessTokenTtlSeconds}`,
      ),
      10,
    );

    if (!Number.isFinite(configuredTtlSeconds) || configuredTtlSeconds <= 0) {
      return accessTokenTtlSeconds;
    }

    return configuredTtlSeconds;
  }
}
