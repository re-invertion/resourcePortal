import { describe, expect, it, beforeEach, vi } from "vitest";
import { PLATFORM_EMAIL_SETTINGS_ID, PlatformEmailService } from "./platform-email.service";

const createTransport = vi.hoisted(() => vi.fn());
vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    id: PLATFORM_EMAIL_SETTINGS_ID,
    enabled: false,
    host: null,
    port: 587,
    mode: "STARTTLS",
    username: null,
    passwordCiphertext: null,
    fromEmail: null,
    fromName: null,
    replyTo: null,
    lastValidatedAt: null,
    lastTestSentAt: null,
    lastError: null,
    updatedBy: null,
    createdAt: new Date("2026-09-27T16:00:00.000Z"),
    updatedAt: new Date("2026-09-27T16:00:00.000Z"),
    ...overrides,
  };
}

function serviceFor(state: ReturnType<typeof baseState>) {
  const update = vi.fn(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      ...state,
      ...data,
      updatedAt: new Date("2026-09-27T16:30:00.000Z"),
    }),
  );
  const auditCreate = vi.fn().mockResolvedValue({});
  const tx = {
    platformEmailSettings: { update },
    auditLogEntry: { create: auditCreate },
  };
  const prisma = {
    platformEmailSettings: {
      upsert: vi.fn().mockResolvedValue(state),
      update,
    },
    auditLogEntry: { create: auditCreate },
    $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
      Promise.resolve(callback(tx)),
    ),
  };
  const encryption = {
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    decrypt: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
  };
  const config = {
    get: vi.fn((key: string, fallback?: unknown) =>
      key === "PUBLIC_API_URL" ? "https://resource-portal.example" : fallback,
    ),
  };
  return {
    prisma,
    encryption,
    service: new PlatformEmailService(prisma as never, encryption as never, config as never),
  };
}

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  displayName: "Admin",
} as never;

describe("PlatformEmailService", () => {
  beforeEach(() => {
    createTransport.mockReset();
  });

  it("stores the SMTP password encrypted and never exposes it in the platform view", async () => {
    const current = baseState();
    const { service, encryption, prisma } = serviceFor(current);

    const result = await service.updatePlatformState({
      enabled: true,
      host: "smtp.example.com",
      port: 587,
      mode: "STARTTLS",
      username: "resourceportal",
      password: "super-secret-password",
      fromEmail: "noreply@example.com",
      fromName: "ResourcePortal",
    }, actor);

    expect(encryption.encrypt).toHaveBeenCalledWith("super-secret-password");
    const updateCall = prisma.platformEmailSettings.update.mock.calls[0]?.[0];
    expect(updateCall?.data.passwordCiphertext).toBe("encrypted:super-secret-password");
    expect(result.passwordConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain("super-secret-password");
    expect(JSON.stringify(result)).not.toContain("passwordCiphertext");
  });

  it("validates the configured SMTP transport without sending a message", async () => {
    const state = baseState({
      enabled: true,
      host: "smtp.example.com",
      username: "resourceportal",
      passwordCiphertext: "encrypted:secret",
      fromEmail: "noreply@example.com",
    });
    const verify = vi.fn().mockResolvedValue(true);
    createTransport.mockReturnValue({ verify });
    const { service } = serviceFor(state);

    const result = await service.validateConnection(actor);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "resourceportal", pass: "secret" },
    }));
    expect(result.lastValidatedAt).toBeInstanceOf(Date);
  });

  it("sends tenant invitations through runtime SMTP and keeps the public link in the message", async () => {
    const state = baseState({
      enabled: true,
      host: "smtp.example.com",
      username: "resourceportal",
      passwordCiphertext: "encrypted:secret",
      fromEmail: "noreply@example.com",
      fromName: "ResourcePortal",
    });
    const sendMail = vi.fn().mockResolvedValue({ messageId: "mail-1" });
    createTransport.mockReturnValue({ sendMail });
    const { service } = serviceFor(state);

    const result = await service.sendTenantInvitation({
      recipient: "alice@example.com",
      tenantName: "Acme",
      token: "opaque-token",
      expiresAt: new Date("2026-09-28T16:00:00.000Z"),
    });

    expect(result).toEqual({ attempted: true, sent: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0]?.[0] as {
      to?: string;
      subject?: string;
      text?: string;
    };
    expect(message.to).toBe("alice@example.com");
    expect(message.subject).toBe("Invitation to Acme on ResourcePortal");
    expect(message.text).toContain("https://resource-portal.example/invitations/opaque-token");
  });
});
