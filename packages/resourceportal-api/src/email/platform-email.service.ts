import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type PlatformEmailSettings } from "@prisma/client";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { EncryptionService } from "../security/encryption.service";
import type { SendTestEmailDto } from "./dto/send-test-email.dto";
import type { UpdatePlatformEmailDto } from "./dto/update-platform-email.dto";

export const PLATFORM_EMAIL_SETTINGS_ID = "3cbd2e90-5478-46b4-a828-1d1fa7cddc07";

type SmtpMode = "STARTTLS" | "TLS" | "PLAIN";

type DeliveryResult = {
  attempted: boolean;
  sent: boolean;
  reason?: string;
};

@Injectable()
export class PlatformEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  async getPlatformState() {
    return this.toView(await this.getState());
  }

  async updatePlatformState(dto: UpdatePlatformEmailDto, actor: AuthenticatedUser) {
    const current = await this.getState();
    const host = dto.host !== undefined ? nullable(dto.host) : current.host;
    const port = dto.port ?? current.port;
    const mode = (dto.mode ?? current.mode) as SmtpMode;
    const username = dto.username !== undefined ? nullable(dto.username) : current.username;
    const fromEmail = dto.fromEmail !== undefined ? nullable(dto.fromEmail ?? "") : current.fromEmail;
    const fromName = dto.fromName !== undefined ? nullable(dto.fromName) : current.fromName;
    const replyTo = dto.replyTo !== undefined ? nullable(dto.replyTo ?? "") : current.replyTo;
    const enabled = dto.enabled ?? current.enabled;

    let passwordCiphertext = current.passwordCiphertext;
    if (!username) {
      passwordCiphertext = null;
    } else if (dto.password?.trim()) {
      passwordCiphertext = this.encryption.encrypt(dto.password);
    }

    const candidate = {
      host,
      port,
      mode,
      username,
      passwordCiphertext,
      fromEmail,
    };
    if (enabled && !this.isConfigured(candidate)) {
      throw new BadRequestException(
        "SMTP host, sender address and authentication credentials must be configured before email delivery can be enabled",
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const state = await tx.platformEmailSettings.update({
        where: { id: PLATFORM_EMAIL_SETTINGS_ID },
        data: {
          enabled,
          host,
          port,
          mode,
          username,
          passwordCiphertext,
          fromEmail,
          fromName,
          replyTo,
          lastValidatedAt: this.configurationChanged(dto) ? null : undefined,
          lastError: this.configurationChanged(dto) ? null : undefined,
          updatedBy: actor.id,
        },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId: null,
          tenantName: "Platform",
          actor: actor.id,
          actorName: actor.displayName,
          action: "platform.email.smtp.update",
          resourceType: "PlatformEmailSettings",
          resourceId: state.id,
          resourceName: "SMTP",
          result: "Success",
          correlationId: randomUUID(),
          changes: {
            enabled: state.enabled,
            host: state.host,
            port: state.port,
            mode: state.mode,
            usernameConfigured: Boolean(state.username),
            passwordConfigured: Boolean(state.passwordCiphertext),
            fromEmail: state.fromEmail,
            fromName: state.fromName,
            replyTo: state.replyTo,
          },
        },
      });
      return state;
    });

    return this.toView(updated);
  }

  async validateConnection(actor: AuthenticatedUser) {
    const state = await this.getState();
    this.assertConfigured(state);
    try {
      await this.createTransport(state).verify();
      const validatedAt = new Date();
      const updated = await this.prisma.platformEmailSettings.update({
        where: { id: PLATFORM_EMAIL_SETTINGS_ID },
        data: { lastValidatedAt: validatedAt, lastError: null, updatedBy: actor.id },
      });
      await this.audit(actor, "platform.email.smtp.validate", {
        host: state.host,
        port: state.port,
        mode: state.mode,
      });
      return this.toView(updated);
    } catch (error) {
      const message = safeSmtpError(error, "SMTP connection validation failed");
      await this.prisma.platformEmailSettings.update({
        where: { id: PLATFORM_EMAIL_SETTINGS_ID },
        data: { lastError: message, updatedBy: actor.id },
      });
      throw new BadGatewayException(message);
    }
  }

  async sendTestEmail(dto: SendTestEmailDto, actor: AuthenticatedUser) {
    const state = await this.getState();
    this.assertConfigured(state);
    try {
      await this.createTransport(state).sendMail({
        from: this.sender(state),
        to: dto.recipient.trim(),
        replyTo: state.replyTo ?? undefined,
        subject: "ResourcePortal SMTP test",
        text: "This message confirms that ResourcePortal can deliver email through the configured SMTP server.",
        html: "<p>This message confirms that <strong>ResourcePortal</strong> can deliver email through the configured SMTP server.</p>",
      });
      const sentAt = new Date();
      const updated = await this.prisma.platformEmailSettings.update({
        where: { id: PLATFORM_EMAIL_SETTINGS_ID },
        data: {
          lastValidatedAt: state.lastValidatedAt ?? sentAt,
          lastTestSentAt: sentAt,
          lastError: null,
          updatedBy: actor.id,
        },
      });
      await this.audit(actor, "platform.email.smtp.test", { recipient: dto.recipient.trim() });
      return { ...this.toView(updated), testRecipient: dto.recipient.trim() };
    } catch (error) {
      const message = safeSmtpError(error, "SMTP test email could not be delivered");
      await this.prisma.platformEmailSettings.update({
        where: { id: PLATFORM_EMAIL_SETTINGS_ID },
        data: { lastError: message, updatedBy: actor.id },
      });
      throw new BadGatewayException(message);
    }
  }

  async sendTenantInvitation(input: {
    recipient: string;
    tenantName: string;
    token: string;
    expiresAt: Date;
  }): Promise<DeliveryResult> {
    const state = await this.getState();
    if (!state.enabled) return { attempted: false, sent: false, reason: "SMTP delivery is disabled" };
    if (!this.isConfigured(state)) return { attempted: false, sent: false, reason: "SMTP is not configured" };

    const invitationUrl = this.invitationUrl(input.token);
    try {
      await this.createTransport(state).sendMail({
        from: this.sender(state),
        to: input.recipient,
        replyTo: state.replyTo ?? undefined,
        subject: `Invitation to ${input.tenantName} on ResourcePortal`,
        text: [
          `You have been invited to ${input.tenantName} on ResourcePortal.`,
          "",
          `Open the invitation: ${invitationUrl}`,
          "",
          `This invitation expires at ${input.expiresAt.toISOString()}.`,
        ].join("\n"),
        html: `<p>You have been invited to <strong>${escapeHtml(input.tenantName)}</strong> on ResourcePortal.</p><p><a href="${escapeHtml(invitationUrl)}">Open invitation</a></p><p>This invitation expires at ${escapeHtml(input.expiresAt.toISOString())}.</p>`,
      });
      if (state.lastError) {
        await this.prisma.platformEmailSettings.update({
          where: { id: PLATFORM_EMAIL_SETTINGS_ID },
          data: { lastError: null },
        });
      }
      return { attempted: true, sent: true };
    } catch (error) {
      const reason = safeSmtpError(error, "Invitation email could not be delivered");
      await this.prisma.platformEmailSettings.update({
        where: { id: PLATFORM_EMAIL_SETTINGS_ID },
        data: { lastError: reason },
      });
      return { attempted: true, sent: false, reason };
    }
  }

  private async getState() {
    return this.prisma.platformEmailSettings.upsert({
      where: { id: PLATFORM_EMAIL_SETTINGS_ID },
      create: {
        id: PLATFORM_EMAIL_SETTINGS_ID,
        enabled: false,
        port: 587,
        mode: "STARTTLS",
      },
      update: {},
    });
  }

  private createTransport(state: PlatformEmailSettings) {
    this.assertConfigured(state);
    const mode = state.mode as SmtpMode;
    const password = state.passwordCiphertext
      ? this.encryption.decrypt(state.passwordCiphertext)
      : undefined;
    return nodemailer.createTransport({
      host: state.host!,
      port: state.port,
      secure: mode === "TLS",
      requireTLS: mode === "STARTTLS",
      ignoreTLS: mode === "PLAIN",
      auth: state.username
        ? { user: state.username, pass: password ?? "" }
        : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      tls: mode === "PLAIN" ? undefined : { minVersion: "TLSv1.2" },
    });
  }

  private sender(state: PlatformEmailSettings) {
    const email = state.fromEmail!;
    return state.fromName ? { name: state.fromName, address: email } : email;
  }

  private invitationUrl(token: string) {
    const base = this.config
      .get<string>("PUBLIC_API_URL", `http://localhost:${this.config.get("PORT", 3000)}`)
      .trim();
    return new URL(`/invitations/${encodeURIComponent(token)}`, base).toString();
  }

  private assertConfigured(state: PlatformEmailSettings) {
    if (!this.isConfigured(state)) {
      throw new BadRequestException("SMTP is not fully configured");
    }
  }

  private isConfigured(state: Pick<PlatformEmailSettings, "host" | "port" | "fromEmail" | "username" | "passwordCiphertext">) {
    return Boolean(
      state.host &&
        state.port > 0 &&
        state.fromEmail &&
        (!state.username || state.passwordCiphertext),
    );
  }

  private configurationChanged(dto: UpdatePlatformEmailDto) {
    return [
      dto.host,
      dto.port,
      dto.mode,
      dto.username,
      dto.password,
      dto.fromEmail,
      dto.fromName,
      dto.replyTo,
    ].some((value) => value !== undefined);
  }

  private toView(state: PlatformEmailSettings) {
    return {
      enabled: state.enabled,
      configured: this.isConfigured(state),
      host: state.host,
      port: state.port,
      mode: state.mode,
      username: state.username,
      passwordConfigured: Boolean(state.passwordCiphertext),
      fromEmail: state.fromEmail,
      fromName: state.fromName,
      replyTo: state.replyTo,
      lastValidatedAt: state.lastValidatedAt,
      lastTestSentAt: state.lastTestSentAt,
      lastError: state.lastError,
      updatedAt: state.updatedAt,
    };
  }

  private audit(actor: AuthenticatedUser, action: string, changes: Record<string, unknown>) {
    return this.prisma.auditLogEntry.create({
      data: {
        tenantId: null,
        tenantName: "Platform",
        actor: actor.id,
        actorName: actor.displayName,
        action,
        resourceType: "PlatformEmailSettings",
        resourceId: PLATFORM_EMAIL_SETTINGS_ID,
        resourceName: "SMTP",
        result: "Success",
        correlationId: randomUUID(),
        changes: changes as Prisma.InputJsonValue,
      },
    });
  }
}

function nullable(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

function safeSmtpError(error: unknown, fallback: string) {
  const value = error as { code?: string; responseCode?: number };
  if (value?.code === "EAUTH" || value?.responseCode === 535) {
    return "SMTP authentication failed";
  }
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNREFUSED"].includes(value?.code ?? "")) {
    return "SMTP connection failed";
  }
  if ((value?.code ?? "").includes("CERT") || (value?.code ?? "").includes("TLS")) {
    return "SMTP TLS validation failed";
  }
  return fallback;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
