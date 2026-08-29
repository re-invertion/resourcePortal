import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import type { JWTPayload, JWTVerifyOptions } from "jose";
import { PrismaService } from "../prisma/prisma.service";
import { AuthenticatedUser } from "./types";

type JoseModule = typeof import("jose");
type RemoteJWKSet = ReturnType<JoseModule["createRemoteJWKSet"]>;

type OidcDiscovery = {
  issuer: string;
  jwksUri: string;
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

  async authenticateBearerToken(token: string): Promise<AuthenticatedUser> {
    const { jwtVerify } = await import("jose");
    const issuer = this.getIssuer();
    const jwks = await this.getJwks();
    const verifyOptions: JWTVerifyOptions = {
      issuer,
    };
    const audience = this.getAudience();

    if (audience.length > 0) {
      verifyOptions.audience = audience.length === 1 ? audience[0] : audience;
    }

    let payload: JWTPayload;

    try {
      const result = await jwtVerify(token, jwks, verifyOptions);
      payload = result.payload;
    } catch {
      throw new UnauthorizedException("OIDC bearer token is invalid");
    }

    return this.findOrProvisionUser(issuer, payload);
  }

  private async findOrProvisionUser(
    issuer: string,
    payload: JWTPayload,
  ): Promise<AuthenticatedUser> {
    const subject = this.requireStringClaim(payload.sub, "sub");
    const email = this.getEmail(payload);
    const displayName = this.getDisplayName(payload, email);
    const providerType = this.config.get<string>(
      "OIDC_PROVIDER_TYPE",
      "zitadel",
    );
    const now = new Date();

    const existingIdentity = await this.prisma.userIdentity.findUnique({
      where: {
        issuer_externalSubject: {
          issuer,
          externalSubject: subject,
        },
      },
      include: {
        user: true,
      },
    });

    if (existingIdentity) {
      if (existingIdentity.user.email !== email) {
        const emailOwner = await this.prisma.user.findUnique({
          where: {
            email,
          },
          select: {
            id: true,
          },
        });

        if (emailOwner && emailOwner.id !== existingIdentity.userId) {
          throw new UnauthorizedException(
            "OIDC email belongs to another user",
          );
        }
      }

      const user = await this.prisma.user.update({
        where: {
          id: existingIdentity.userId,
        },
        data: {
          email,
          displayName,
          status: UserStatus.Active,
          identities: {
            update: {
              where: {
                id: existingIdentity.id,
              },
              data: {
                email,
                lastLoginAt: now,
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

      return user;
    }

    const userByEmail = await this.prisma.user.findUnique({
      where: {
        email,
      },
      select: {
        id: true,
      },
    });

    if (userByEmail) {
      return this.prisma.user.update({
        where: {
          id: userByEmail.id,
        },
        data: {
          displayName,
          status: UserStatus.Active,
          identities: {
            create: {
              providerType,
              issuer,
              externalSubject: subject,
              email,
              lastLoginAt: now,
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

  private async getDiscovery(): Promise<OidcDiscovery> {
    if (this.discovery) {
      return this.discovery;
    }

    this.discoveryPromise ??= this.fetchDiscovery();
    this.discovery = await this.discoveryPromise;
    return this.discovery;
  }

  private async fetchDiscovery(): Promise<OidcDiscovery> {
    const issuer = this.getIssuer();
    const response = await fetch(
      `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    );

    if (!response.ok) {
      throw new UnauthorizedException("OIDC discovery document is unavailable");
    }

    const discovery = (await response.json()) as Record<string, unknown>;
    const discoveredIssuer = discovery.issuer;
    const jwksUri = discovery.jwks_uri;

    if (typeof discoveredIssuer === "string" && discoveredIssuer !== issuer) {
      throw new UnauthorizedException("OIDC issuer mismatch");
    }

    if (typeof jwksUri !== "string" || jwksUri.length === 0) {
      throw new UnauthorizedException("OIDC discovery document misses jwks_uri");
    }

    return {
      issuer,
      jwksUri,
    };
  }

  private getIssuer() {
    const issuer = this.config.get<string>("OIDC_ISSUER_URL");

    if (!issuer) {
      throw new UnauthorizedException("OIDC_ISSUER_URL is required");
    }

    return issuer.replace(/\/$/, "");
  }

  private getAudience() {
    const audience = this.config.get<string>("OIDC_AUDIENCE");
    const clientId = this.config.get<string>("OIDC_CLIENT_ID");
    const value = audience || clientId || "";

    return value
      .split(",")
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

    if (typeof name === "string" && name.length > 0) {
      return name;
    }

    if (
      typeof preferredUsername === "string" &&
      preferredUsername.length > 0
    ) {
      return preferredUsername;
    }

    return email;
  }

  private isAutoProvisionEnabled() {
    return (
      this.config
        .get<string>("OIDC_AUTO_PROVISION_USERS", "true")
        .toLowerCase() !== "false"
    );
  }

  private requireStringClaim(value: unknown, claimName: string) {
    if (typeof value !== "string" || value.length === 0) {
      throw new UnauthorizedException(`OIDC ${claimName} claim is required`);
    }

    return value;
  }
}
