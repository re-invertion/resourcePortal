import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

type JsonObject = Record<string, unknown>;

@Injectable()
export class ZitadelServiceIdentityService {
  constructor(private readonly config: ConfigService) {}

  async create(id: string, name: string, description?: string) {
    const user = await this.request<{ userId?: string }>(
      "POST",
      "/management/v1/users/machine",
      {
        userName: `rp-si-${id}`,
        name,
        ...(description ? { description } : {}),
        accessTokenType: "ACCESS_TOKEN_TYPE_JWT",
        userId: id,
      },
    );
    if (!user.userId) {
      throw new BadGatewayException("ZITADEL service account creation did not return userId");
    }

    try {
      const secret = await this.request<{ clientId?: string; clientSecret?: string }>(
        "PUT",
        `/management/v1/users/${encodeURIComponent(user.userId)}/secret`,
      );
      if (!secret.clientId || !secret.clientSecret) {
        throw new BadGatewayException("ZITADEL service account secret creation did not return credentials");
      }
      return {
        userId: user.userId,
        clientId: secret.clientId,
        clientSecret: secret.clientSecret,
      };
    } catch (error) {
      await this.deactivateIgnoringFailure(user.userId);
      throw error;
    }
  }

  async update(userId: string, name: string, description?: string) {
    await this.request("PUT", `/management/v1/users/${encodeURIComponent(userId)}/machine`, {
      name,
      description: description ?? "",
    });
  }

  async setActive(userId: string, active: boolean) {
    await this.request(
      "POST",
      `/management/v1/users/${encodeURIComponent(userId)}/${active ? "_reactivate" : "_deactivate"}`,
      undefined,
      [400],
    );
  }

  async disable(userId: string) {
    await this.request(
      "DELETE",
      `/management/v1/users/${encodeURIComponent(userId)}/secret`,
      undefined,
      [404],
    );
    await this.setActive(userId, false);
  }

  private async deactivateIgnoringFailure(userId: string) {
    try {
      await this.setActive(userId, false);
    } catch {
      // Preserve the original provisioning error.
    }
  }

  private async request<T = JsonObject>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body?: JsonObject,
    ignoredStatuses: number[] = [],
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.managementToken()}`,
        "content-type": "application/json",
        "x-zitadel-orgid": this.organizationId(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok && !ignoredStatuses.includes(response.status)) {
      throw new BadGatewayException(`ZITADEL service identity request failed with HTTP ${response.status}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private baseUrl() {
    const value = this.config.get<string>("ZITADEL_MANAGEMENT_URL") ?? this.config.get<string>("OIDC_ISSUER_URL");
    if (!value) throw new ServiceUnavailableException("ZITADEL_MANAGEMENT_URL or OIDC_ISSUER_URL is required");
    return value.replace(/\/$/, "");
  }

  private managementToken() {
    const value = this.config.get<string>("ZITADEL_MANAGEMENT_TOKEN") ?? this.config.get<string>("ZITADEL_BOOTSTRAP_PAT");
    if (!value) throw new ServiceUnavailableException("ZITADEL_MANAGEMENT_TOKEN is required for service identity provisioning");
    return value;
  }

  private organizationId() {
    const value = this.config.get<string>("ZITADEL_ORGANIZATION_ID");
    if (!value) throw new ServiceUnavailableException("ZITADEL_ORGANIZATION_ID is required for service identity provisioning");
    return value;
  }
}
