import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ResourceBot v1 migration", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260927111500_resource_bot_v1/migration.sql",
    ),
    "utf8",
  );

  it("is additive and preserves default-on tenant semantics", () => {
    expect(migration).toContain('CREATE TABLE "TenantResourceBotSettings"');
    expect(migration).toContain('"enabled" BOOLEAN NOT NULL DEFAULT true');
    expect(migration).toContain('CREATE TABLE "PlatformResourceBotSettings"');
    expect(migration).toContain('CREATE TABLE "ResourceBotKnowledgeEmbedding"');
    expect(migration).toContain('CREATE TABLE "ResourceBotUsageRecord"');
    expect(migration).toContain('CREATE TABLE "ResourceBotUsageReservation"');
    expect(migration).toContain('CREATE TABLE "ResourceBotPriceVersion"');
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });

  it("installs ResourceBot permissions for upgrades without exposing a plaintext provider key", () => {
    expect(migration).toContain("'resourcebot.use'");
    expect(migration).toContain("'resourcebot.settings.manage'");
    expect(migration).toContain('"apiKeyCiphertext" TEXT');
    expect(migration).not.toMatch(/"apiKey"\s+TEXT/i);
  });

  it("persists generation and embedding usage needed for immutable tenant settlement", () => {
    expect(migration).toContain('"embeddingInputTokens" INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('"embeddingCreditsPer1M" DECIMAL(24,8) NOT NULL');
    expect(migration).toContain('"requestId" TEXT NOT NULL');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "ResourceBotUsageRecord_requestId_key"',
    );
  });
});
