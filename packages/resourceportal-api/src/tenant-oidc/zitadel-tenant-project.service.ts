import { BadGatewayException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

type ProjectResponse = { id?: string };
type RoleResponse = Record<string, unknown>;
type GrantResponse = { userGrantId?: string };

@Injectable()
export class ZitadelTenantProjectService {
  constructor(private readonly config: ConfigService) {}

  get issuer(): string {
    const issuer = this.config.get<string>("OIDC_ISSUER_URL")?.replace(/\/$/, "");
    if (!issuer || !issuer.startsWith("https://")) {
      throw new ServiceUnavailableException("Secure ZITADEL OIDC issuer is not configured");
    }
    return issuer;
  }

  /** Only enable tenant OIDC after the real issuer serves an RFC-compliant
   * authorization-code flow and usable public signing keys over HTTPS.
   * This check deliberately does not pretend to authenticate a human user;
   * the full login/PKCE/revocation E2E belongs to the release certification.
   */
  async verifyIssuerSecurity(): Promise<void> {
    const issuer = this.issuer;
    const origin = new URL(issuer).origin;
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
    const discoveryResponse = await fetch(discoveryUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!discoveryResponse.ok) {
      throw new ServiceUnavailableException("ZITADEL issuer discovery is unavailable");
    }
    const document = await discoveryResponse.json() as {
      issuer?: string;
      jwks_uri?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      response_types_supported?: string[];
      code_challenge_methods_supported?: string[];
    };
    const sameOriginHttps = (url: string | undefined) => {
      if (!url) return false;
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && parsed.origin === origin &&
          parsed.username === "" && parsed.password === "" && parsed.hash === "";
      } catch { return false; }
    };
    if (document.issuer?.replace(/\/$/, "") !== issuer ||
        !sameOriginHttps(document.jwks_uri) ||
        !sameOriginHttps(document.authorization_endpoint) ||
        !sameOriginHttps(document.token_endpoint) ||
        !document.response_types_supported?.includes("code") ||
        !document.code_challenge_methods_supported?.includes("S256")) {
      throw new ServiceUnavailableException("ZITADEL OIDC issuer or PKCE metadata is invalid");
    }
    const jwksResponse = await fetch(document.jwks_uri!, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!jwksResponse.ok) {
      throw new ServiceUnavailableException("ZITADEL signing keys are unavailable");
    }
    const jwks = await jwksResponse.json() as {
      keys?: Array<{ kid?: string; kty?: string; use?: string; alg?: string }>;
    };
    if (!Array.isArray(jwks.keys) || !jwks.keys.some((key) =>
      typeof key.kid === "string" && key.kid.length > 0 &&
      ["RSA", "EC"].includes(key.kty ?? "") &&
      (key.use === undefined || key.use === "sig") &&
      key.alg !== "none")) {
      throw new ServiceUnavailableException("ZITADEL issuer has no usable signing keys");
    }
  }

  async verifyMemberGrant(userId: string, grantId: string, projectId: string): Promise<void> {
    const response = await this.request<{
      userGrant?: { projectId?: string; roleKeys?: string[] };
    }>("GET", `/management/v1/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(grantId)}`);
    if (response.userGrant?.projectId !== projectId ||
        !response.userGrant.roleKeys?.includes("rp.tenant.member")) {
      throw new ServiceUnavailableException("ZITADEL member grant does not match this tenant project");
    }
  }

  async createProject(tenantId: string): Promise<string> {
    const response = await this.request<ProjectResponse>("POST", "/management/v1/projects", {
      name: `rp-tenant-${tenantId}`,
      projectRoleAssertion: true,
      projectRoleCheck: true,
      hasProjectCheck: true,
      privateLabelingSetting: "PRIVATE_LABELING_SETTING_UNSPECIFIED",
    });
    if (!response.id || !/^\d+$/.test(response.id)) {
      throw new BadGatewayException("ZITADEL did not return a valid tenant project ID");
    }
    return response.id;
  }

  /**
   * Recover an already-created project after a crash between the ZITADEL
   * create response and the local database write. Never create another project
   * when the management search fails or finds multiple matching projects.
   */
  async findExistingProjectForTenant(tenantId: string): Promise<string | null> {
    const name = `rp-tenant-${tenantId}`;
    const response = await this.request<{
      result?: Array<{ id?: string; name?: string }>;
      details?: { totalResult?: string | number };
    }>("POST", "/management/v1/projects/_search", {
      query: { limit: 100 },
      queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
    });
    const matches = (response.result ?? []).filter((project) => project.name === name);
    if (matches.length > 1 || Number(response.details?.totalResult ?? matches.length) > 1) {
      throw new ServiceUnavailableException("Ambiguous existing ZITADEL tenant project; manual recovery required");
    }
    if (matches.length === 0) return null;
    const id = matches[0]?.id;
    if (!id || !/^\d+$/.test(id)) {
      throw new ServiceUnavailableException("Existing ZITADEL tenant project has an invalid identifier");
    }
    await this.readProject(id);
    return id;
  }

  async ensureMemberRole(projectId: string) {
    const roles = await this.request<{ result?: Array<{ key?: string }> }>(
      "POST",
      `/management/v1/projects/${encodeURIComponent(projectId)}/roles/_search`,
      { query: { limit: 100 } },
    );
    if (roles.result?.some((role) => role.key === "rp.tenant.member")) return;
    await this.request<RoleResponse>(
      "POST",
      `/management/v1/projects/${encodeURIComponent(projectId)}/roles`,
      { roleKey: "rp.tenant.member", displayName: "Tenant member" },
    );
  }

  /** Recover a grant created before a crash or persistence failure. ZITADEL
   * is the source of truth for upstream grants; never create a duplicate on
   * retry and never guess when multiple matching role grants are returned.
   */
  async findExistingMemberGrant(userId: string, projectId: string): Promise<string | null> {
    const response = await this.request<{
      result?: Array<{ id?: string; userId?: string; projectId?: string; roleKeys?: string[] }>;
      details?: { totalResult?: string | number };
    }>("POST", "/management/v1/users/grants/_search", {
      query: { limit: 100 },
      queries: [{ userIdQuery: { userId } }],
    });
    if (Number(response.details?.totalResult ?? 0) > (response.result?.length ?? 0)) {
      throw new ServiceUnavailableException("ZITADEL grant search is incomplete; manual recovery required");
    }
    const found = (response.result ?? []).filter((row) =>
      row.userId === userId && row.projectId === projectId &&
      row.roleKeys?.includes("rp.tenant.member"),
    );
    if (found.length > 1 || found.some((row) => !row.id)) {
      throw new ServiceUnavailableException("Ambiguous existing ZITADEL tenant membership grant");
    }
    return found[0]?.id ?? null;
  }

  async assignMember(userId: string, projectId: string): Promise<string> {
    const response = await this.request<GrantResponse>(
      "POST",
      `/management/v1/users/${encodeURIComponent(userId)}/grants`,
      { projectId, roleKeys: ["rp.tenant.member"] },
    );
    if (!response.userGrantId) {
      throw new BadGatewayException("ZITADEL did not return a role assignment ID");
    }
    return response.userGrantId;
  }

  async revokeMember(userId: string, grantId: string) {
    await this.request(
      "DELETE",
      `/management/v1/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(grantId)}`,
      undefined,
      [404],
    );
  }

  async readProject(projectId: string) {
    const response = await this.request<{
      project?: { id?: string; projectRoleCheck?: boolean; hasProjectCheck?: boolean };
    }>("GET", `/management/v1/projects/${encodeURIComponent(projectId)}`);
    const project = response.project;
    if (
      project?.id !== projectId ||
      project.projectRoleCheck !== true ||
      project.hasProjectCheck !== true
    ) {
      throw new ServiceUnavailableException("Tenant ZITADEL project security checks are not enabled");
    }
    return project;
  }

  async deleteProject(projectId: string) {
    await this.request(
      "DELETE",
      `/management/v1/projects/${encodeURIComponent(projectId)}`,
      undefined,
      [404],
    );
  }

  private async request<T = Record<string, unknown>>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    ignoredStatuses: number[] = [],
  ): Promise<T> {
    const base = (this.config.get<string>("ZITADEL_MANAGEMENT_URL") ?? this.issuer)
      .replace(/\/$/, "");
    const token = this.config.get<string>("ZITADEL_MANAGEMENT_TOKEN");
    const orgId = this.config.get<string>("ZITADEL_ORGANIZATION_ID");
    if (!token || !orgId) {
      throw new ServiceUnavailableException("ZITADEL management credentials are not configured");
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-zitadel-orgid": orgId,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok && !ignoredStatuses.includes(response.status)) {
      throw new BadGatewayException(`ZITADEL tenant project operation failed (HTTP ${response.status})`);
    }
    if (response.status === 204) return {} as T;
    const raw = await response.text();
    if (!raw) return {} as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new BadGatewayException("ZITADEL response is not valid JSON");
    }
  }
}
