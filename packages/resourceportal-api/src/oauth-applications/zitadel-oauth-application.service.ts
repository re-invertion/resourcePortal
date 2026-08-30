import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OAuthApplicationType } from "./dto/create-oauth-application.dto";

export type ZitadelOAuthApplicationConfiguration = {
  name: string;
  type: OAuthApplicationType;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
};

type JsonObject = Record<string, unknown>;

@Injectable()
export class ZitadelOAuthApplicationService {
  constructor(private readonly config: ConfigService) {}

  async provision(configuration: ZitadelOAuthApplicationConfiguration) {
    if (configuration.type === "Machine") {
      const response = await this.request<{
        appId?: string;
        clientId?: string;
        clientSecret?: string;
      }>("POST", `${this.projectPath()}/apps/api`, {
        name: configuration.name,
        authMethodType: "API_AUTH_METHOD_TYPE_BASIC",
      });
      return this.assertCreated(response);
    }

    const response = await this.request<{
      appId?: string;
      clientId?: string;
      clientSecret?: string;
    }>("POST", `${this.projectPath()}/apps/oidc`, this.oidcBody(configuration, true));
    return this.assertCreated(response);
  }

  async update(applicationId: string, configuration: ZitadelOAuthApplicationConfiguration) {
    await this.request("PUT", `${this.projectPath()}/apps/${encodeURIComponent(applicationId)}`, {
      name: configuration.name,
    });

    if (configuration.type !== "Machine") {
      await this.request(
        "PUT",
        `${this.projectPath()}/apps/${encodeURIComponent(applicationId)}/oidc_config`,
        this.oidcBody(configuration, false),
      );
    }
  }

  delete(applicationId: string) {
    return this.request(
      "DELETE",
      `${this.projectPath()}/apps/${encodeURIComponent(applicationId)}`,
      undefined,
      [404],
    );
  }

  private oidcBody(configuration: ZitadelOAuthApplicationConfiguration, includeName: boolean) {
    const appType =
      configuration.type === "Web"
        ? "OIDC_APP_TYPE_WEB"
        : configuration.type === "SPA"
          ? "OIDC_APP_TYPE_USER_AGENT"
          : "OIDC_APP_TYPE_NATIVE";
    const authMethodType =
      configuration.type === "Web"
        ? "OIDC_AUTH_METHOD_TYPE_BASIC"
        : "OIDC_AUTH_METHOD_TYPE_NONE";

    return {
      ...(includeName ? { name: configuration.name } : {}),
      redirectUris: configuration.redirectUris,
      responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
      appType,
      authMethodType,
      postLogoutRedirectUris: configuration.postLogoutRedirectUris,
      version: "OIDC_VERSION_1_0",
      devMode: this.config.get<string>("NODE_ENV", "development") !== "production",
      accessTokenType: "OIDC_TOKEN_TYPE_JWT",
      idTokenUserinfoAssertion: true,
    };
  }

  private assertCreated(response: { appId?: string; clientId?: string; clientSecret?: string }) {
    if (!response.appId || !response.clientId) {
      throw new BadGatewayException("ZITADEL application creation did not return appId/clientId");
    }
    return {
      applicationId: response.appId,
      clientId: response.clientId,
      clientSecret: response.clientSecret,
    };
  }

  private projectPath() {
    return `/management/v1/projects/${encodeURIComponent(this.projectId())}`;
  }

  private projectId() {
    const value = this.config.get<string>("ZITADEL_PROJECT_ID");
    if (!value) {
      throw new ServiceUnavailableException("ZITADEL_PROJECT_ID is required for OAuth application provisioning");
    }
    return value;
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
      throw new BadGatewayException(`ZITADEL application request failed with HTTP ${response.status}`);
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
    if (!value) throw new ServiceUnavailableException("ZITADEL_MANAGEMENT_TOKEN is required for OAuth application provisioning");
    return value;
  }

  private organizationId() {
    const value = this.config.get<string>("ZITADEL_ORGANIZATION_ID");
    if (!value) throw new ServiceUnavailableException("ZITADEL_ORGANIZATION_ID is required for OAuth application provisioning");
    return value;
  }
}
