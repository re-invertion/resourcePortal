export type ResourcePortalClientOptions = {
  apiUrl: string;
  devUserId?: string;
  token?: string;
  fetchImpl?: typeof fetch;
};

export type ResourcePortalRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
};

export class ResourcePortalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
    this.name = "ResourcePortalApiError";
  }
}

export class ResourcePortalClient {
  readonly account = {
    me: () => this.request("/auth/me"),
  };

  readonly tenants = {
    list: () => this.request("/tenants"),
    get: (tenantId: string) => this.request(`/tenants/${encode(tenantId)}`),
    create: (body: unknown) =>
      this.request("/tenants", { method: "POST", body }),
    billing: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/billing`),
    billingTransactions: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/billing/transactions`),
    usageRecords: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/billing/usage-records`),
    topUpBilling: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/billing/top-up`, {
        method: "POST",
        body,
      }),
    quota: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/quota`),
    updateQuota: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/quota`, {
        method: "PATCH",
        body,
      }),
    authPolicy: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/auth-policy`),
    updateAuthPolicy: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/auth-policy`, {
        method: "PATCH",
        body,
      }),
    roles: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/roles`),
    memberships: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/memberships`),
    createMembership: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/memberships`, {
        method: "POST",
        body,
      }),
    updateMembership: (tenantId: string, membershipId: string, body: unknown) =>
      this.request(
        `/tenants/${encode(tenantId)}/memberships/${encode(membershipId)}`,
        { method: "PATCH", body },
      ),
    deleteMembership: (tenantId: string, membershipId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/memberships/${encode(membershipId)}`,
        { method: "DELETE" },
      ),
    invitations: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/invitations`),
    createInvitation: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/invitations`, {
        method: "POST",
        body,
      }),
    resendInvitation: (tenantId: string, invitationId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/invitations/${encode(invitationId)}/resend`,
        { method: "POST" },
      ),
    deleteInvitation: (tenantId: string, invitationId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/invitations/${encode(invitationId)}`,
        { method: "DELETE" },
      ),
    groups: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/groups`),
    createGroup: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/groups`, {
        method: "POST",
        body,
      }),
    updateGroup: (tenantId: string, groupId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/groups/${encode(groupId)}`, {
        method: "PATCH",
        body,
      }),
    deleteGroup: (tenantId: string, groupId: string) =>
      this.request(`/tenants/${encode(tenantId)}/groups/${encode(groupId)}`, {
        method: "DELETE",
      }),
    addGroupMember: (tenantId: string, groupId: string, body: unknown) =>
      this.request(
        `/tenants/${encode(tenantId)}/groups/${encode(groupId)}/members`,
        { method: "POST", body },
      ),
    removeGroupMember: (
      tenantId: string,
      groupId: string,
      membershipId: string,
    ) =>
      this.request(
        `/tenants/${encode(tenantId)}/groups/${encode(groupId)}/members/${encode(membershipId)}`,
        { method: "DELETE" },
      ),
    assignGroupRole: (tenantId: string, groupId: string, body: unknown) =>
      this.request(
        `/tenants/${encode(tenantId)}/groups/${encode(groupId)}/roles`,
        { method: "POST", body },
      ),
    removeGroupRole: (tenantId: string, groupId: string, roleId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/groups/${encode(groupId)}/roles/${encode(roleId)}`,
        { method: "DELETE" },
      ),
  };

  readonly invitations = {
    accept: (body: unknown) =>
      this.request("/invitations/accept", { method: "POST", body }),
  };

  readonly identityProviders = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/identity-providers`),
    get: (tenantId: string, identityProviderId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/identity-providers/${encode(identityProviderId)}`,
      ),
    create: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/identity-providers`, {
        method: "POST",
        body,
      }),
    update: (tenantId: string, identityProviderId: string, body: unknown) =>
      this.request(
        `/tenants/${encode(tenantId)}/identity-providers/${encode(identityProviderId)}`,
        { method: "PATCH", body },
      ),
    delete: (tenantId: string, identityProviderId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/identity-providers/${encode(identityProviderId)}`,
        { method: "DELETE" },
      ),
  };

  readonly appGroups = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/app-groups`),
    create: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/app-groups`, {
        method: "POST",
        body,
      }),
    get: (tenantId: string, appGroupId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}`,
      ),
    previewStack: (tenantId: string, appGroupId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/stack-preview`,
      ),
    discardChanges: (tenantId: string, appGroupId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/discard-changes`,
        { method: "POST" },
      ),
    delete: (tenantId: string, appGroupId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}`,
        { method: "DELETE" },
      ),
    start: (tenantId: string, appGroupId: string) =>
      this.postRuntime(tenantId, appGroupId, "start"),
    stop: (tenantId: string, appGroupId: string) =>
      this.postRuntime(tenantId, appGroupId, "stop"),
    restart: (tenantId: string, appGroupId: string) =>
      this.postRuntime(tenantId, appGroupId, "restart"),
  };

  readonly deployments = {
    list: (tenantId: string, appGroupId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/deployments`,
      ),
    get: (tenantId: string, appGroupId: string, deploymentId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/deployments/${encode(deploymentId)}`,
      ),
    events: (tenantId: string, appGroupId: string, deploymentId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/deployments/${encode(deploymentId)}/events`,
      ),
    create: (
      tenantId: string,
      appGroupId: string,
      body: unknown,
      idempotencyKey?: string,
    ) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/deploy`,
        { method: "POST", body, idempotencyKey },
      ),
    rollback: (
      tenantId: string,
      appGroupId: string,
      deploymentId: string,
      body: unknown,
      idempotencyKey?: string,
    ) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/deployments/${encode(deploymentId)}/rollback`,
        { method: "POST", body, idempotencyKey },
      ),
  };

  readonly apps = {
    list: (tenantId: string, appGroupId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps`,
      ),
    create: (tenantId: string, appGroupId: string, body: unknown) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps`,
        { method: "POST", body },
      ),
    update: (
      tenantId: string,
      appGroupId: string,
      singleAppId: string,
      body: unknown,
    ) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}`,
        { method: "PATCH", body },
      ),
    delete: (tenantId: string, appGroupId: string, singleAppId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}`,
        { method: "DELETE" },
      ),
    start: (tenantId: string, appGroupId: string, singleAppId: string) =>
      this.postAppRuntime(tenantId, appGroupId, singleAppId, "start"),
    stop: (tenantId: string, appGroupId: string, singleAppId: string) =>
      this.postAppRuntime(tenantId, appGroupId, singleAppId, "stop"),
    restart: (tenantId: string, appGroupId: string, singleAppId: string) =>
      this.postAppRuntime(tenantId, appGroupId, singleAppId, "restart"),
    runtimeConfig: (tenantId: string, appGroupId: string, singleAppId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/runtime-config`,
      ),
    updateRuntimeConfig: (
      tenantId: string,
      appGroupId: string,
      singleAppId: string,
      body: unknown,
    ) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/runtime-config`,
        { method: "PATCH", body },
      ),
  };

  readonly variables = resourceCollection(this, "variables");
  readonly configs = resourceCollection(this, "configs");
  readonly secrets = resourceCollection(this, "secrets");
  readonly endpoints = nestedCollection(this, "http-endpoints");

  readonly volumes = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/volumes`),
    get: (tenantId: string, volumeId: string) =>
      this.request(`/tenants/${encode(tenantId)}/volumes/${encode(volumeId)}`),
    create: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/volumes`, {
        method: "POST",
        body,
      }),
    resize: (tenantId: string, volumeId: string, body: unknown) =>
      this.request(
        `/tenants/${encode(tenantId)}/volumes/${encode(volumeId)}/resize`,
        { method: "PATCH", body },
      ),
    delete: (tenantId: string, volumeId: string) =>
      this.request(`/tenants/${encode(tenantId)}/volumes/${encode(volumeId)}`, {
        method: "DELETE",
      }),
    attach: (
      tenantId: string,
      appGroupId: string,
      singleAppId: string,
      body: unknown,
    ) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/volume-attachments`,
        { method: "POST", body },
      ),
    detach: (
      tenantId: string,
      appGroupId: string,
      singleAppId: string,
      attachmentId: string,
    ) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/volume-attachments/${encode(attachmentId)}`,
        { method: "DELETE" },
      ),
  };

  readonly domains = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/domains`),
    get: (tenantId: string, domainId: string) =>
      this.request(`/tenants/${encode(tenantId)}/domains/${encode(domainId)}`),
    create: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/domains`, {
        method: "POST",
        body,
      }),
    update: (tenantId: string, domainId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/domains/${encode(domainId)}`, {
        method: "PATCH",
        body,
      }),
    validate: (tenantId: string, domainId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/domains/${encode(domainId)}/validate`,
        { method: "POST" },
      ),
    delete: (tenantId: string, domainId: string) =>
      this.request(`/tenants/${encode(tenantId)}/domains/${encode(domainId)}`, {
        method: "DELETE",
      }),
  };

  readonly customRootDomains = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/domains/custom-root-domains`),
    get: (tenantId: string, customRootDomainId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/domains/custom-root-domains/${encode(customRootDomainId)}`,
      ),
    create: (tenantId: string, body: unknown) =>
      this.request(`/tenants/${encode(tenantId)}/domains/custom-root-domains`, {
        method: "POST",
        body,
      }),
    update: (tenantId: string, customRootDomainId: string, body: unknown) =>
      this.request(
        `/tenants/${encode(tenantId)}/domains/custom-root-domains/${encode(customRootDomainId)}`,
        { method: "PATCH", body },
      ),
    validate: (tenantId: string, customRootDomainId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/domains/custom-root-domains/${encode(customRootDomainId)}/validate`,
        { method: "POST" },
      ),
    delete: (tenantId: string, customRootDomainId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/domains/custom-root-domains/${encode(customRootDomainId)}`,
        { method: "DELETE" },
      ),
  };

  readonly registries = topLevelCollection(this, "registries");

  readonly auditLog = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/audit-log`),
  };

  private readonly apiUrl: string;
  private readonly devUserId?: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResourcePortalClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
    this.devUserId = options.devUserId;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T = unknown>(
    path: string,
    options: ResourcePortalRequestOptions = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(this.devUserId ? { "x-dev-user-id": this.devUserId } : {}),
        ...(options.idempotencyKey
          ? { "idempotency-key": options.idempotencyKey }
          : {}),
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new ResourcePortalApiError(
        `Resource Portal API request failed with HTTP ${response.status}`,
        response.status,
        payload,
      );
    }

    return payload as T;
  }

  private postRuntime(
    tenantId: string,
    appGroupId: string,
    action: "start" | "stop" | "restart",
  ) {
    return this.request(
      `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/runtime/${action}`,
      { method: "POST" },
    );
  }

  private postAppRuntime(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    action: "start" | "stop" | "restart",
  ) {
    return this.request(
      `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/runtime/${action}`,
      { method: "POST" },
    );
  }
}

function resourceCollection(
  client: ResourcePortalClient,
  resource: "variables" | "configs" | "secrets",
) {
  const attachmentResource =
    resource === "variables"
      ? "variable"
      : resource === "configs"
        ? "config"
        : "secret";

  return {
    list: (tenantId: string, appGroupId: string) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/${resource}`,
      ),
    create: (tenantId: string, appGroupId: string, body: unknown) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/${resource}`,
        { method: "POST", body },
      ),
    update: (
      tenantId: string,
      appGroupId: string,
      resourceId: string,
      body: unknown,
    ) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/${resource}/${encode(resourceId)}`,
        { method: "PATCH", body },
      ),
    delete: (tenantId: string, appGroupId: string, resourceId: string) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/${resource}/${encode(resourceId)}`,
        { method: "DELETE" },
      ),
    attach: (
      tenantId: string,
      appGroupId: string,
      singleAppId: string,
      body: unknown,
    ) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/${attachmentResource}-attachments`,
        { method: "POST", body },
      ),
    detach: (
      tenantId: string,
      appGroupId: string,
      singleAppId: string,
      attachmentId: string,
    ) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/${attachmentResource}-attachments/${encode(attachmentId)}`,
        { method: "DELETE" },
      ),
  };
}

function nestedCollection(
  client: ResourcePortalClient,
  resource: "http-endpoints",
) {
  return {
    list: (tenantId: string, appGroupId: string, singleAppId: string) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/${resource}`,
      ),
    get: (
      tenantId: string,
      appGroupId: string,
      singleAppId: string,
      resourceId: string,
    ) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/${resource}/${encode(resourceId)}`,
      ),
    create: (
      tenantId: string,
      appGroupId: string,
      singleAppId: string,
      body: unknown,
    ) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/${resource}`,
        { method: "POST", body },
      ),
    update: (
      tenantId: string,
      appGroupId: string,
      singleAppId: string,
      resourceId: string,
      body: unknown,
    ) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/${resource}/${encode(resourceId)}`,
        { method: "PATCH", body },
      ),
    delete: (
      tenantId: string,
      appGroupId: string,
      singleAppId: string,
      resourceId: string,
    ) =>
      client.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}/single-apps/${encode(singleAppId)}/${resource}/${encode(resourceId)}`,
        { method: "DELETE" },
      ),
  };
}

function topLevelCollection(client: ResourcePortalClient, resource: "registries") {
  return {
    list: (tenantId: string) =>
      client.request(`/tenants/${encode(tenantId)}/${resource}`),
    get: (tenantId: string, resourceId: string) =>
      client.request(
        `/tenants/${encode(tenantId)}/${resource}/${encode(resourceId)}`,
      ),
    create: (tenantId: string, body: unknown) =>
      client.request(`/tenants/${encode(tenantId)}/${resource}`, {
        method: "POST",
        body,
      }),
    update: (tenantId: string, resourceId: string, body: unknown) =>
      client.request(
        `/tenants/${encode(tenantId)}/${resource}/${encode(resourceId)}`,
        { method: "PATCH", body },
      ),
    validate: (tenantId: string, resourceId: string) =>
      client.request(
        `/tenants/${encode(tenantId)}/${resource}/${encode(resourceId)}/validate`,
        { method: "POST" },
      ),
    delete: (tenantId: string, resourceId: string) =>
      client.request(
        `/tenants/${encode(tenantId)}/${resource}/${encode(resourceId)}`,
        { method: "DELETE" },
      ),
  };
}

function encode(value: string) {
  return encodeURIComponent(value);
}
