import { randomBytes } from "node:crypto";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, UserStatus } from "@prisma/client";
import { FastifyRequest } from "fastify";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import { AuthenticatedUser } from "./types";
import { TokenResponse } from "./auth-flow.service";
import { OidcAuthService } from "./oidc-auth.service";

type RefreshTokenResponse = {
  access_token: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
};

type PortalSessionWithUser = Prisma.PortalSessionGetPayload<{
  include: {
    user: true;
  };
}>;

@Injectable()
export class AuthSessionService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly oidcAuth: OidcAuthService,
    private readonly encryption: EncryptionService,
  ) {}

  async createSession(userId: string, tokens: TokenResponse) {
    const now = Date.now();
    const accessTokenTtlSeconds = tokens.expires_in ?? 3600;
    const sessionTtlSeconds = this.getSessionTtlSeconds(accessTokenTtlSeconds);
    const expiresAt = new Date(now + sessionTtlSeconds * 1000);

    const session = await this.prisma.portalSession.create({
      data: {
        id: randomBytes(32).toString("base64url"),
        userId,
        accessToken: this.encryption.encrypt(tokens.access_token),
        refreshToken: tokens.refresh_token
          ? this.encryption.encrypt(tokens.refresh_token)
          : "",
        idToken: this.encryption.encrypt(tokens.id_token),
        accessTokenExpiresAt: new Date(now + accessTokenTtlSeconds * 1000),
        expiresAt,
      },
      select: {
        id: true,
        expiresAt: true,
      },
    });

    await this.writeSessionAudit({
      action: "auth.session.created",
      actor: userId,
      actorName: userId,
      result: "Success",
      sessionId: session.id,
      changes: {
        expiresAt: session.expiresAt.toISOString(),
      },
    });

    return session;
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

    const now = Date.now();

    if (!session || !this.isSessionUsable(session, now)) {
      if (session && !session.revokedAt) {
        await this.revokeSession(session.id);
      }
      throw new UnauthorizedException("Session is invalid");
    }

    if (session.accessTokenExpiresAt.getTime() <= now) {
      await this.refreshSessionTokens(session);
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

    const session = await this.prisma.portalSession.findUnique({
      where: {
        id: sessionId,
      },
      include: {
        user: true,
      },
    });

    await this.prisma.portalSession.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    await this.writeSessionAudit({
      action: "auth.session.revoked",
      actor: session?.user.id ?? "system",
      actorName: session?.user.displayName ?? "system",
      result: "Success",
      sessionId,
    });
  }

  async pruneExpiredSessions(now = new Date()) {
    const idleCutoff = new Date(
      now.getTime() - this.getIdleTimeoutSeconds() * 1000,
    );
    const result = await this.prisma.portalSession.updateMany({
      where: {
        OR: [
          {
            expiresAt: {
              lte: now,
            },
          },
          {
            lastSeenAt: {
              lte: idleCutoff,
            },
          },
        ],
        revokedAt: null,
      },
      data: {
        revokedAt: now,
      },
    });

    await this.writeSessionAudit({
      action: "auth.sessions.pruned",
      actor: "system",
      actorName: "system",
      result: "Success",
      changes: {
        revokedSessions: result.count,
      },
    });

    return {
      revokedSessions: result.count,
    };
  }

  getSessionCookieName() {
    return this.config.get<string>("AUTH_SESSION_COOKIE_NAME", "rp_session");
  }

  getCsrfCookieName() {
    return this.config.get<string>("AUTH_CSRF_COOKIE_NAME", "rp_csrf");
  }

  getSessionIdFromRequest(request: FastifyRequest) {
    const value = request.cookies[this.getSessionCookieName()];

    if (!value) {
      return undefined;
    }

    if (typeof request.unsignCookie !== "function") {
      return value;
    }

    const unsigned = request.unsignCookie(value);

    if (!unsigned.valid) {
      return undefined;
    }

    return unsigned.value;
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

  private isSessionUsable(session: PortalSessionWithUser, now: number) {
    const idleTimeoutMs = this.getIdleTimeoutSeconds() * 1000;

    return (
      !session.revokedAt &&
      session.expiresAt.getTime() > now &&
      session.lastSeenAt.getTime() + idleTimeoutMs > now &&
      session.user.status === UserStatus.Active
    );
  }

  private async refreshSessionTokens(session: PortalSessionWithUser) {
    if (!session.refreshToken) {
      await this.revokeSession(session.id);
      throw new UnauthorizedException("Session refresh token is missing");
    }

    try {
      const refreshToken = this.encryption.decrypt(session.refreshToken);
      const tokens = await this.exchangeRefreshToken(refreshToken);
      const accessTokenTtlSeconds = tokens.expires_in ?? 3600;

      await this.prisma.portalSession.update({
        where: {
          id: session.id,
        },
        data: {
          accessToken: this.encryption.encrypt(tokens.access_token),
          accessTokenExpiresAt: new Date(
            Date.now() + accessTokenTtlSeconds * 1000,
          ),
          idToken: this.encryption.encrypt(
            tokens.id_token
              ? tokens.id_token
              : this.encryption.decrypt(session.idToken),
          ),
          refreshToken: this.encryption.encrypt(
            tokens.refresh_token
              ? tokens.refresh_token
              : this.encryption.decrypt(session.refreshToken),
          ),
        },
      });

      await this.writeSessionAudit({
        action: "auth.session.refreshed",
        actor: session.user.id,
        actorName: session.user.displayName,
        result: "Success",
        sessionId: session.id,
        changes: {
          accessTokenExpiresInSeconds: accessTokenTtlSeconds,
        },
      });
    } catch (error) {
      await this.writeSessionAudit({
        action: "auth.session.refresh_failed",
        actor: session.user.id,
        actorName: session.user.displayName,
        result: "Failure",
        sessionId: session.id,
        errorCode: "OIDC_REFRESH_FAILED",
        errorMessage:
          error instanceof Error ? error.message : "Session refresh failed",
      });
      await this.revokeSession(session.id);

      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException("Session refresh failed");
    }
  }

  private async exchangeRefreshToken(refreshToken: string) {
    const discovery = await this.oidcAuth.getDiscovery();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.getClientId(),
    });
    const clientSecret = this.getClientSecret();
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };

    if (clientSecret) {
      headers.authorization = `Basic ${Buffer.from(
        `${this.getClientId()}:${clientSecret}`,
      ).toString("base64")}`;
    }

    const response = await fetch(discovery.tokenEndpoint, {
      method: "POST",
      headers,
      body,
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : {};

    if (!response.ok || !isRefreshTokenResponse(payload)) {
      throw new UnauthorizedException("OIDC refresh token exchange failed");
    }

    return payload;
  }

  private getClientId() {
    const clientId = this.config.get<string>("OIDC_CLIENT_ID");

    if (!clientId) {
      throw new UnauthorizedException("OIDC_CLIENT_ID is required");
    }

    return clientId;
  }

  private getClientSecret() {
    return this.config.get<string>("OIDC_CLIENT_SECRET");
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

  private getIdleTimeoutSeconds() {
    const configuredIdleTimeoutSeconds = Number.parseInt(
      this.config.get<string>("AUTH_SESSION_IDLE_TIMEOUT_SECONDS", "1800"),
      10,
    );

    if (
      !Number.isFinite(configuredIdleTimeoutSeconds) ||
      configuredIdleTimeoutSeconds <= 0
    ) {
      return 1800;
    }

    return configuredIdleTimeoutSeconds;
  }

  private async writeSessionAudit(event: {
    action: string;
    actor: string;
    actorName: string;
    result: "Failure" | "Success";
    sessionId?: string;
    errorCode?: string;
    errorMessage?: string;
    changes?: Record<string, unknown>;
  }) {
    const changes = {
      ...event.changes,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    };

    try {
      await this.prisma.auditLogEntry.create({
        data: {
          tenantId: null,
          tenantName: "global",
          actor: event.actor,
          actorName: event.actorName,
          action: event.action,
          resourceType: "PortalSession",
          resourceId: null,
          resourceName: event.sessionId,
          result: event.result,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          changes,
        },
      });
    } catch {
      // Authentication must not fail just because audit persistence is temporarily unavailable.
    }
  }
}

function isRefreshTokenResponse(
  payload: unknown,
): payload is RefreshTokenResponse {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const value = payload as Record<string, unknown>;

  return typeof value.access_token === "string";
}
