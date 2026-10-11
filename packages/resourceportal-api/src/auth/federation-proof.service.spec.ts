import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { FederationProofService } from "./federation-proof.service";

const secret = "this-is-a-long-unique-secret-for-federation-e2e-123456789";
const nonce = "A".repeat(43);

function fixture() {
  const proof = { nonce, providerId: "actual-oidc-idp", consumedAt: null as Date | null,
    createdAt: new Date() };
  const create = vi.fn(async (args: { data: { nonce: string; providerId: string } }) => {
    proof.providerId = args.data.providerId;
    return proof;
  });
  const findUnique = vi.fn().mockResolvedValue(proof);
  const updateMany = vi.fn(async (args: { where: {
    nonce: string; providerId: string; consumedAt: null; createdAt: { gte: Date };
  }; data: { consumedAt: Date } }) => {
    if (args.where.nonce !== proof.nonce ||
        args.where.providerId !== proof.providerId ||
        proof.consumedAt || proof.createdAt < args.where.createdAt.gte) {
      return { count: 0 };
    }
    proof.consumedAt = args.data.consumedAt;
    return { count: 1 };
  });
  const prisma = { federationLoginProof: { create, findUnique, updateMany } };
  const service = new FederationProofService(prisma as unknown as PrismaService, {
    get: vi.fn((key: string) => key === "FEDERATION_ATTESTATION_SECRET" ? secret : undefined),
  } as unknown as ConfigService);
  return { proof, create, findUnique, updateMany, service };
}

describe("ZITADEL external authentication evidence (#238)", () => {
  it("rejects unauthenticated, malformed and non-IdP evidence", async () => {
    const f = fixture();
    await expect(f.service.record(undefined, { nonce, providerId: "actual-oidc-idp" }))
      .rejects.toThrow("Invalid federation attestation credentials");
    await expect(f.service.record("Bearer incorrect", { nonce, providerId: "actual-oidc-idp" }))
      .rejects.toThrow("Invalid federation attestation credentials");
    await expect(f.service.record(`Bearer ${secret}`, { nonce: "../../../", providerId: "test" }))
      .rejects.toThrow("Invalid federation attestation");
    expect(f.create).not.toHaveBeenCalled();
  });
  it("accepts actual provider evidence, never a different selected provider", async () => {
    const f = fixture();
    expect(await f.service.record(`Bearer ${secret}`, {
      nonce, providerId: "actual-oidc-idp",
    })).toEqual({ accepted: true });
    expect(await f.service.consume(nonce, "other-tenant-idp")).toBe(false);
    expect(await f.service.consume(nonce, "actual-oidc-idp")).toBe(true);
    expect(await f.service.consume(nonce, "actual-oidc-idp")).toBe(false);
    expect(f.updateMany).toHaveBeenCalledTimes(3);
  });
  it("denies expired evidence and impossible nonce", async () => {
    const f = fixture();
    f.proof.createdAt = new Date(Date.now() - 601_000);
    expect(await f.service.consume(nonce, "actual-oidc-idp")).toBe(false);
    expect(await f.service.consume("bad", "actual-oidc-idp")).toBe(false);
  });
});
