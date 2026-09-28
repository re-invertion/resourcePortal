import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export const RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION = "ResourcePortal managed SMTP";

type SmtpMode = "STARTTLS" | "TLS" | "PLAIN";

type ReconcileInput = {
  enabled: boolean;
  host: string | null;
  port: number;
  mode: SmtpMode;
  username: string | null;
  password?: string;
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
};

type EmailProvider = {
  id?: string;
  state?: string;
  description?: string;
};

@Injectable()
export class ZitadelEmailProviderService {
  constructor(private readonly config: ConfigService) {}

  async reconcile(input: ReconcileInput) {
    if (!input.enabled) {
      await this.disableManagedProviders();
      return { providerId: null };
    }

    if (!input.host || !input.fromEmail) {
      throw new Error("ZITADEL SMTP synchronization failed: SMTP is not fully configured");
    }

    const existing = await this.listProviders();
    const managed = existing.filter(isManagedProvider);
    const body = {
      senderAddress: input.fromEmail,
      senderName: input.fromName ?? "",
      tls: input.mode !== "PLAIN",
      host: `${input.host}:${input.port}`,
      user: input.username ?? "",
      replyToAddress: input.replyTo ?? "",
      description: RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION,
      ...(input.username
        ? { plain: { password: input.password ?? "" } }
        : { none: {} }),
    };

    const created = await this.request<{ id?: string }>(
      "/admin/v1/email/smtp",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    const providerId = created.id?.trim();
    if (!providerId) {
      throw new Error("ZITADEL SMTP synchronization failed: provider id was not returned");
    }

    try {
      await this.request(
        `/admin/v1/email/${encodeURIComponent(providerId)}/_activate`,
        { method: "POST", body: "{}" },
      );
      await this.waitUntilActive(providerId);
    } catch (error) {
      await this.removeProvider(providerId).catch(() => undefined);
      throw error;
    }

    for (const provider of managed) {
      if (!provider.id || provider.id === providerId) continue;
      await this.removeProvider(provider.id);
    }

    return { providerId };
  }

  private async disableManagedProviders() {
    const providers = await this.listProviders();
    const managed = providers.filter(isManagedProvider);
    const active = await this.getActiveProvider();

    if (active?.id && active.description !== RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION) {
      throw new Error(
        "ZITADEL SMTP synchronization failed: an unmanaged email provider is active",
      );
    }

    for (const provider of managed) {
      if (!provider.id) continue;
      if (provider.id === active?.id || provider.state === "EMAIL_PROVIDER_ACTIVE") {
        await this.request(
          `/admin/v1/email/${encodeURIComponent(provider.id)}/_deactivate`,
          { method: "POST", body: "{}" },
        );
      }
      await this.removeProvider(provider.id);
    }
  }

  private async listProviders() {
    const response = await this.request<{ result?: EmailProvider[] }>(
      "/admin/v1/email/_search",
      { method: "POST", body: "{}" },
    );
    return response.result ?? [];
  }

  private async getActiveProvider() {
    const response = await this.request<{ config?: EmailProvider | null }>(
      "/admin/v1/email",
      { method: "GET" },
      [404],
    );
    return response.config ?? null;
  }

  private async waitUntilActive(providerId: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const active = await this.getActiveProvider();
      if (active?.id === providerId) return;
      await delay(100);
    }
    throw new Error(
      "ZITADEL SMTP synchronization failed: provider activation was not observed",
    );
  }

  private removeProvider(providerId: string) {
    return this.request(
      `/admin/v1/email/${encodeURIComponent(providerId)}`,
      { method: "DELETE" },
      [404],
    );
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    init: RequestInit,
    ignoredStatuses: number[] = [],
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.managementToken()}`);
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}${path}`, { ...init, headers });
    } catch {
      throw new Error(
        "ZITADEL SMTP synchronization failed: management API is unavailable",
      );
    }

    const text = await response.text();
    if (!response.ok && !ignoredStatuses.includes(response.status)) {
      throw new Error(
        `ZITADEL SMTP synchronization failed with HTTP ${response.status}`,
      );
    }

    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        "ZITADEL SMTP synchronization failed: invalid management API response",
      );
    }
  }

  private baseUrl() {
    const value =
      this.config.get<string>("ZITADEL_MANAGEMENT_URL") ??
      this.config.get<string>("OIDC_ISSUER_URL");

    if (!value) {
      throw new ServiceUnavailableException(
        "ZITADEL_MANAGEMENT_URL or OIDC_ISSUER_URL is required",
      );
    }

    return value.replace(/\/$/, "");
  }

  private managementToken() {
    const value =
      this.config.get<string>("ZITADEL_MANAGEMENT_TOKEN") ??
      this.config.get<string>("ZITADEL_BOOTSTRAP_PAT");

    if (!value) {
      throw new ServiceUnavailableException(
        "ZITADEL_MANAGEMENT_TOKEN is required for SMTP synchronization",
      );
    }

    return value;
  }
}

function isManagedProvider(provider: EmailProvider) {
  return provider.description === RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
