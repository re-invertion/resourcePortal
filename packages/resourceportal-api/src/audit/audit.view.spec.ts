import { AuditLogEntry } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { mapAuditLogEntry } from "./audit.view";

describe("mapAuditLogEntry", () => {
  it("redacts sensitive values recursively while preserving safe metadata", () => {
    const entry = {
      id: "22222222-2222-4222-8222-222222222222",
      tenantId: "11111111-1111-4111-8111-111111111111",
      tenantName: "tenant",
      timestamp: new Date("2026-08-30T12:00:00Z"),
      actor: "user-1",
      actorName: "User",
      action: "registry.update",
      resourceType: "Registry",
      resourceId: "33333333-3333-4333-8333-333333333333",
      resourceName: "private-registry",
      result: "Success",
      errorCode: null,
      errorMessage: null,
      requestId: "req-1",
      correlationId: "44444444-4444-4444-8444-444444444444",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      changes: {
        host: "registry.example.test",
        password: "plaintext-password",
        clientSecret: "plaintext-client-secret",
        nested: {
          accessToken: "plaintext-access-token",
          safe: "kept",
        },
      },
    } satisfies AuditLogEntry;

    expect(mapAuditLogEntry(entry).changes).toEqual({
      host: "registry.example.test",
      password: "[REDACTED]",
      clientSecret: "[REDACTED]",
      nested: {
        accessToken: "[REDACTED]",
        safe: "kept",
      },
    });
  });
});
