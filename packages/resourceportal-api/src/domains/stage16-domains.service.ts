import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CustomRootDomainVerificationStatus } from "@prisma/client";
import { resolveTxt } from "node:dns/promises";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { DomainsService } from "./domains.service";

const NEGATIVE_DNS_CODES = new Set(["ENODATA", "ENOTFOUND"]);

export type RetryableDnsVerificationError = Error & {
  code: "DnsResolverUnavailable";
  retryable: true;
  cause?: unknown;
};

export function isCompletedNegativeDnsAnswer(error: unknown) {
  return NEGATIVE_DNS_CODES.has(errorCode(error) ?? "");
}

export function dnsResolverUnavailable(error: unknown) {
  const wrapped = new Error(
    error instanceof Error ? error.message : "DNS resolver unavailable",
  ) as RetryableDnsVerificationError;
  wrapped.code = "DnsResolverUnavailable";
  wrapped.retryable = true;
  wrapped.cause = error;
  return wrapped;
}

@Injectable()
export class Stage16DomainsService extends DomainsService {
  constructor(prisma: PrismaService, config: ConfigService) {
    super(prisma, config);
  }

  override async validateCustomRootDomain(
    tenantId: string,
    customRootDomainId: string,
    actor: AuthenticatedUser,
  ) {
    const existing = await this.getCustomRootDomain(
      tenantId,
      customRootDomainId,
    );

    let verified = false;
    try {
      const txtRecords = await resolveTxt(existing.rootDomain);
      verified = txtRecords
        .map((parts) => parts.join(""))
        .some((value) => value.trim() === existing.verificationToken);
    } catch (error: unknown) {
      if (!isCompletedNegativeDnsAnswer(error)) {
        throw dnsResolverUnavailable(error);
      }
    }

    return this.updateCustomRootDomain(
      tenantId,
      customRootDomainId,
      {
        verificationStatus: verified
          ? CustomRootDomainVerificationStatus.Verified
          : CustomRootDomainVerificationStatus.Failed,
      },
      actor,
    );
  }
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
