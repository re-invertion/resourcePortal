import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { deriveFederationAttestationSecret } from "./federation-attestation-secret";
import { PrismaService } from "../prisma/prisma.service";

// A login hint is a correlation handle, not evidence. ZITADEL alone can
// submit the result of its actual External Authentication post-auth action.
export const federationHintPrefix = "rp-proof-";
const noncePattern = /^[A-Za-z0-9_-]{43}$/;
const idpPattern = /^[A-Za-z0-9_-]{1,256}$/;

@Injectable()
export class FederationProofService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async record(
    authorization: string | undefined,
    body: { nonce?: unknown; providerId?: unknown } | undefined,
  ) {
    const secret = this.attestationSecret();
    if (!secret || secret.length < 32) {
      throw new ServiceUnavailableException("Federation attestation is not configured");
    }
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const a = createHash("sha256").update(bearer).digest();
    const b = createHash("sha256").update(secret).digest();
    if (!bearer || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("Invalid federation attestation credentials");
    }
    if (typeof body?.nonce !== "string" || !noncePattern.test(body.nonce) ||
        typeof body.providerId !== "string" || !idpPattern.test(body.providerId)) {
      throw new BadRequestException("Invalid federation attestation");
    }
    const nonce = body.nonce;
    const providerId = body.providerId;
    try {
      await this.prisma.federationLoginProof.create({
        data: { nonce, providerId },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const current = await this.prisma.federationLoginProof.findUnique({ where: { nonce } });
        if (current?.providerId === providerId && !current.consumedAt &&
            current.createdAt.getTime() >= Date.now() - 600_000) {
          return { accepted: true };
        }
        throw new ConflictException("Conflicting or already consumed federation attestation");
      }
      throw error;
    }
    return { accepted: true };
  }

  /**
   * Exact provider, short expiry and atomic consumption prevent cross-login
   * reuse. The caller must validate the callback OIDC state, code+PKCE and
   * issuer-signed ID token BEFORE consuming this attestation.
   */
  private attestationSecret(): string | undefined {
    const explicit = this.config.get<string>("FEDERATION_ATTESTATION_SECRET");
    if (explicit) return explicit;
    const masterPath = this.config.get<string>("RESOURCE_ENCRYPTION_KEY_FILE");
    if (!masterPath) return undefined;
    try {
      return deriveFederationAttestationSecret(readFileSync(masterPath));
    } catch {
      // An unreadable or invalid secret must never enable unauthenticated proof.
      return undefined;
    }
  }

  async consume(nonce: string, expectedProviderId: string): Promise<boolean> {
    if (!noncePattern.test(nonce) || !idpPattern.test(expectedProviderId)) return false;
    const result = await this.prisma.federationLoginProof.updateMany({
      where: {
        nonce,
        providerId: expectedProviderId,
        consumedAt: null,
        createdAt: { gte: new Date(Date.now() - 600_000) },
      },
      data: { consumedAt: new Date() },
    });
    return result.count === 1;
  }
}
