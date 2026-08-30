import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import type { JWTPayload, JWTVerifyOptions } from "jose";
import { PrismaService } from "../prisma/prisma.service";
import {
  AuthenticatedServiceIdentity,
  AuthenticatedUser,
} from "./types";

type JoseModule = typeof import("jose");
type RemoteJWKSet = ReturnType<JoseModule["createRemoteJWKSet"]>;

export type OidcDiscovery = {
  authorizationEndpoint: string;
  issuer: string;
  jwksUri: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  endSessionEndpoint?: string;
};

export type AuthenticatedPrincipal =
  | { type: "User"; user: AuthenticatedUser }
  | { type: "ServiceIdentity"; serviceIdentity: AuthenticatedServiceIdentity };

type ServiceIdentityRecord = {
  id: string;
  tenantId: string;
  name: string;
  status: "Active" | "Suspended";
  zitadelUserId: string;
  clientId: string;
};

@Injectable()
export class OidcAuthService {
  private discovery?: OidcDiscovery;
  private discoveryPromise?: Promise<OidcDiscovery>;
  private jwks?: RemoteJWKSet;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async authenticateBearerToken(
    token: string,
    identityProviderId?: string,
  ): Promise<AuthenticatedUser> {
    const payload = await this.verifyToken(token);
    return this.findOrProvisionUser(this.getIssuer(), payload, identityProviderId);
  }

  async authenticatePrincipalToken(token: string): Promise<AuthenticatedPrincipal> {
    const payload = await this.verifyToken(token);
    const subject = this.requireStringClaim(payload.sub, "sub");
    const serviceIdentity = await this.findServiceIdentity(subject);

    if (serviceIdentity) {
      if (serviceIdentity.status !== "Active") {
        throw new UnauthorizedException("Service identity is suspended");
      }
      return {
        type: "ServiceIdentity",
        serviceIdentity,
      };
    }

    return {
      type: "User",
      user: await this.findOrProvisionUser(this.getIssuer(), payload),
    };
  }

  private async verifyToken(token: string) {
    const { jwtVerify } = await import("jose");
    const issuer = this.getIssuer();
    const jwks = await this.getJwks();
    const verifyOptions: JWTVerifyOptions = { issuer };
    const audience = this.getAudience();

    if (audience.length > 0) {
      verifyOptions.audience = audience.length === 1 ? audience[0] : audience;
    }

    try {
      const result = await jwtVerify(token, jwks, verifyOptions);
      return result.payload;
    } catch {
      throw new UnauthorizedException("OIDC bearer token is invalid");
    }
  }

  private async findServiceIdentity(subject: string) {
    const rows = await this.prisma.$queryRaw<ServiceIdentityRecord[]>`
      SELECT "id", "tenantId", "name", "status", "zitadelUserId", "clientId"
      FROM "ServiceIdentity"
      WHERE "zitadelUserId" = ${subject}
      LIMIT 1
    `;
    return rows[0];
  }

  private async findOrProvisionUser(
    issuer: string,
    payload: JWTPayload,
    identityProviderId?: string,
  ): Promise<AuthenticatedUser> {
    const subject = this.requireStringClaim(payload.sub, "sub");
    const email = this.getEmail(payload);
    const displayName = this.getDisplayName(payload, email);
    const providerType = this.config.get<string>("OIDC_PROVIDER_TYPE", "zitadel");
    const now = new Date();

    const existingIdentity = await this.prisma.userIdentity.findUnique({
      where: {
        issuer_externalSubject: {
          issuer,
          externalSubject: subject,
        },
      },
      include: { user: true },
    });

    if (existingIdentity) {
      if (existingIdentity.user.email !== email) {
        const emailOwner = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });
        if (emailOwner && emailOwner.id !== existingIdentity.userId) {
          throw new UnauthorizedException("OIDC email belongs to another user");
        }
      }

      return this.prisma.user.update({
        where: { id: existingIdentity.userId },
        data: {
          email,
          displayName,
          status: UserStatus.Active,
          identities: {
            update: {
              where: { id: existingIdentity.id },
              data: {
                email,
                lastLoginAt: now,
                ...(identityProviderId
                  ? { identityProvider: { connect: { id: identityProviderId } } }
                  : {}),
              },
            },
          },
        },
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
        },
      });
    }

    const userByEmail = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (userByEmail) {
      throw new UnauthorizedException(
        "OIDC identity is not linked to the existing user account",
      );
    }

    if (!this.isAutoProvisionEnabled()) {
      throw new UnauthorizedException("OIDC user is not provisioned");
    }

    return this.prisma.user.create({
      data: {
        email,
        displayName,
        status: UserStatus.Active,
        identities: {
          create: {
            providerType,
            issuer,
            externalSubject: subject,
            email,
            lastLoginAt: now,
            ...(identityProviderId
              ? { identityProvider: { connect: { id: identityProviderId } } }
              : {}),
          },
        },
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
      },
    });
  }

  private async getJwks(): Promise<RemoteJWKSet> {
    if (!this.jwks) {
      const { createRemoteJWKSet } = await import("jose");
      const discovery = await this.getDiscovery();
      this.jwks = createRemoteJWKSet(new URL(discovery.jwksUri));
    }
    return this.jwks;
  }

  async getDiscovery(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    this.discoveryPromise ??= this.fetchDiscovery();
    this.discovery = await this.discoveryPromise;
    return this.discovery;
  }

  private async fetchDiscovery(): Promise<OidcDiscovery> {
    const issuer = this.getIssuer();
    const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!response.ok) {
      throw new UnauthorizedException("OIDC discovery document is unavailable");
    }

    const discovery = (await response.json()) as Record<string, unknown>;
    const discoveredIssuer = discovery.issuer;
    const authorizationEndpoint = discovery.authorization_endpoint;
    const jwksUri = discovery.jwks_uri;
    const tokenEndpoint = discovery.token_endpoint;
    const revocationEndpoint = discovery.revocation_endpoint;
    const endSessionEndpoint = discovery.end_session_endpoint;

    if (typeof discoveredIssuer === "string" && discoveredIssuer !== issuer) {
      throw new UnauthorizedException("OIDC issuer mismatch");
    }
    if (typeof jwksUri !== "string" || jwksUri.length === 0) {
      throw new UnauthorizedException("OIDC discovery document misses jwks_uri");
    }
    if (typeof authorizationEndpoint !== "string" || authorizationEndpoint.length === 0) {
      throw new UnauthorizedException("OIDC discovery document misses authorization_endpoint");
    }
    if (typeof tokenEndpoint !== "string" || tokenEndpoint.length === 0) {
      throw new UnauthorizedException("OIDC discovery document misses token_endpoint");
    }

    return {
      authorizationEndpoint,
      issuer,
      jwksUri,
      tokenEndpoint,
      revocationEndpoint:
        typeof revocationEndpoint === "string" && revocationEndpoint.length > 0
          ? revocationEndpoint
          : undefined,
      endSessionEndpoint:
        typeof endSessionEndpoint === "string" && endSessionEndpoint.length > 0
          ? endSessionEndpoint
          : undefined,
    };
  }

  private getIssuer() {
    const issuer = this.config.get<string>("OIDC_ISSUER_URL");
    if (!issuer) throw new UnauthorizedException("OIDC_ISSUER_URL is required");
    return issuer.replace(/\/$/, "");
  }

  private getAudience() {
    const audience = this.config.get<string>("OIDC_AUDIENCE");
    const clientId = this.config.get<string>("OIDC_CLIENT_ID");
    const projectId = this.config.get<string>("ZITADEL_PROJECT_ID");
    return [...new Set([...(audience || clientId || "").split(","), projectId ?? ""])]
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private getEmail(payload: JWTPayload) {
    const email = payload.email;
    if (typeof email !== "string" || email.length === 0) {
      throw new UnauthorizedException("OIDC email claim is required");
    }
    return email.toLowerCase();
  }

  private getDisplayName(payload: JWTPayload, email: string) {
    const name = payload.name;
    const preferredUsername = payload.preferred_username;
    if (typeof name === "string" && name.length > 0) return name;
    if (typeof preferredUsername === "string" && preferredUsername.length > 0) {
      return preferredUsername;
    }
    return email;
  }

  private isAutoProvisionEnabled() {
    return this.config.get<string>("OIDC_AUTO_PROVISION_USERS", "true").toLowerCase() !== "false";
  }

  private requireStringClaim(value: unknown, claimName: string) {
    if (typeof value !== "string" || value.length === 0) {
      throw new UnauthorizedException(`OIDC ${claimName} claim is required`);
    }
    return value;
  }
}
