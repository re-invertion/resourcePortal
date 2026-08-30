import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IdentityProviderProtocol } from "@prisma/client";

export type ZitadelProviderConfiguration = {
  clientId?: string;
  clientSecret?: string;
  enabled: boolean;
  issuer?: string;
  metadataUrl?: string;
  name: string;
  protocol: IdentityProviderProtocol;
  scopes: string[];
  usePkce: boolean;
};

type JsonObject = Record<string, unknown>;

type ZitadelLoginPolicy = {
  allowDomainDiscovery?: boolean;
  allowExternalIdp?: boolean;
  allowRegister?: boolean;
  allowUsernamePassword?: boolean;
  defaultRedirectUri?: string;
  disableLoginWithEmail?: boolean;
  disableLoginWithPhone?: boolean;
  externalLoginCheckLifetime?: string;
  forceMfa?: boolean;
  forceMfaLocalOnly?: boolean;
  hidePasswordReset?: boolean;
  ignoreUnknownUsernames?: boolean;
  isDefault?: boolean;
  mfaInitSkipLifetime?: string;
  multiFactorCheckLifetime?: string;
  multiFactors?: string[];
  passwordCheckLifetime?: string;
  passwordlessType?: string;
  secondFactorCheckLifetime?: string;
  secondFactors?: string[];
};

type ZitadelLoginPolicyResponse = {
  isDefault?: boolean;
  policy?: ZitadelLoginPolicy;
};

const writableLoginPolicyFields = [
  "allowUsernamePassword",
  "allowRegister",
  "forceMfa",
  "passwordlessType",
  "hidePasswordReset",
  "ignoreUnknownUsernames",
  "defaultRedirectUri",
  "passwordCheckLifetime",
  "externalLoginCheckLifetime",
  "mfaInitSkipLifetime",
  "secondFactorCheckLifetime",
  "multiFactorCheckLifetime",
  "secondFactors",
  "multiFactors",
  "allowDomainDiscovery",
  "disableLoginWithEmail",
  "disableLoginWithPhone",
  "forceMfaLocalOnly",
] as const satisfies ReadonlyArray<keyof ZitadelLoginPolicy>;

@Injectable()
export class ZitadelIdentityProviderService {
  constructor(private readonly config: ConfigService) {}

  async provision(configuration: ZitadelProviderConfiguration) {
    const response = await this.request<{ id?: string }>(
      "POST",
      this.providerPath(configuration.protocol),
      this.providerBody(configuration),
    );

    if (!response.id) {
      throw new BadGatewayException(
        "ZITADEL identity provider creation did not return an id",
      );
    }

    if (configuration.enabled) {
      try {
        await this.ensureExternalIdpAllowed();
        await this.setLoginPolicyLink(response.id, true);
      } catch (error) {
        await this.deleteTemplateIgnoringFailure(response.id);
        throw error;
      }
    }

    return response.id;
  }

  async update(
    identityProviderId: string,
    configuration: ZitadelProviderConfiguration,
  ) {
    await this.request(
      "PUT",
      `${this.providerPath(configuration.protocol)}/${encodeURIComponent(identityProviderId)}`,
      this.providerBody(configuration),
    );
  }

  async setEnabled(identityProviderId: string, enabled: boolean) {
    if (enabled) {
      await this.ensureExternalIdpAllowed();
    }

    await this.setLoginPolicyLink(identityProviderId, enabled);
  }

  async delete(identityProviderId: string) {
    await this.setLoginPolicyLink(identityProviderId, false);
    await this.deleteTemplate(identityProviderId);
  }

  private async ensureExternalIdpAllowed() {
    const current = await this.getLoginPolicy();

    if (!current.policy) {
      throw new BadGatewayException(
        "ZITADEL login policy response did not contain a policy",
      );
    }

    const isDefault = current.isDefault ?? current.policy.isDefault ?? true;
    if (!isDefault && current.policy.allowExternalIdp === true) {
      return;
    }

    await this.request(
      isDefault ? "POST" : "PUT",
      "/management/v1/policies/login",
      this.loginPolicyBody(current.policy),
    );

    const verified = await this.getLoginPolicy();
    const verifiedIsDefault =
      verified.isDefault ?? verified.policy?.isDefault ?? true;
    if (
      !verified.policy ||
      verifiedIsDefault ||
      verified.policy.allowExternalIdp !== true
    ) {
      throw new BadGatewayException(
        "ZITADEL login policy did not enable external identity providers",
      );
    }
  }

  private getLoginPolicy() {
    return this.request<ZitadelLoginPolicyResponse>(
      "GET",
      "/management/v1/policies/login",
    );
  }

  private loginPolicyBody(policy: ZitadelLoginPolicy): JsonObject {
    const body: JsonObject = { allowExternalIdp: true };

    for (const field of writableLoginPolicyFields) {
      const value = policy[field];
      if (value !== undefined) {
        body[field] = value;
      }
    }

    body.allowExternalIdp = true;
    return body;
  }

  private async setLoginPolicyLink(identityProviderId: string, enabled: boolean) {
    if (enabled) {
      await this.request(
        "POST",
        "/management/v1/policies/login/idps",
        {
          idpId: identityProviderId,
          ownerType: "IDP_OWNER_TYPE_ORG",
        },
        [409],
      );
      return;
    }

    await this.request(
      "DELETE",
      `/management/v1/policies/login/idps/${encodeURIComponent(identityProviderId)}`,
      undefined,
      [404],
    );
  }

  private deleteTemplate(identityProviderId: string) {
    return this.request(
      "DELETE",
      `/management/v1/idps/templates/${encodeURIComponent(identityProviderId)}`,
      undefined,
      [404],
    );
  }

  private async deleteTemplateIgnoringFailure(identityProviderId: string) {
    try {
      await this.deleteTemplate(identityProviderId);
    } catch {
      // Preserve the login-policy error; reconciliation can remove the orphan.
    }
  }

  private providerPath(protocol: IdentityProviderProtocol) {
    return protocol === IdentityProviderProtocol.OIDC
      ? "/management/v1/idps/generic_oidc"
      : "/management/v1/idps/saml";
  }

  private providerBody(configuration: ZitadelProviderConfiguration): JsonObject {
    const providerOptions = {
      autoLinking: "AUTO_LINKING_OPTION_UNSPECIFIED",
      isAutoCreation: true,
      isAutoUpdate: true,
      isCreationAllowed: false,
      isLinkingAllowed: true,
    };

    if (configuration.protocol === IdentityProviderProtocol.OIDC) {
      return {
        name: configuration.name,
        issuer: configuration.issuer,
        clientId: configuration.clientId,
        ...(configuration.clientSecret
          ? { clientSecret: configuration.clientSecret }
          : {}),
        scopes: normalizeScopes(configuration.scopes),
        providerOptions,
        isIdTokenMapping: true,
        usePkce: configuration.usePkce,
      };
    }

    return {
      name: configuration.name,
      metadataUrl: configuration.metadataUrl,
      binding: "SAML_BINDING_REDIRECT",
      withSignedRequest: false,
      providerOptions,
      federatedLogoutEnabled: false,
    };
  }

  private async request<T = JsonObject>(
    method: "GET" | "POST" | "PUT" | "DELETE",
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

    if (!response.ok && !ignoredStatuses.includes(response.status)) {
      throw new BadGatewayException(
        `ZITADEL identity provider request failed with HTTP ${response.status}`,
      );
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
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
        "ZITADEL_MANAGEMENT_TOKEN is required for identity provider provisioning",
      );
    }

    return value;
  }

  private organizationId() {
    const value = this.config.get<string>("ZITADEL_ORGANIZATION_ID");

    if (!value) {
      throw new ServiceUnavailableException(
        "ZITADEL_ORGANIZATION_ID is required for identity provider provisioning",
      );
    }

    return value;
  }
}

function normalizeScopes(scopes: string[]) {
  return [...new Set(["openid", ...scopes.map((scope) => scope.trim())])].filter(
    Boolean,
  );
}
