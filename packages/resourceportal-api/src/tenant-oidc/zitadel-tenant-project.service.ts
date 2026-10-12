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
