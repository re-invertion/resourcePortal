export type ResourcePortalClientOptions = {
  apiUrl: string;
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
  };

  readonly appGroups = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/app-groups`),
    get: (tenantId: string, appGroupId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/app-groups/${encode(appGroupId)}`,
      ),
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
  };

  readonly volumes = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/volumes`),
  };

  readonly domains = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/domains`),
  };

  readonly registries = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/registries`),
  };

  private readonly apiUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResourcePortalClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, "");
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
}

function encode(value: string) {
  return encodeURIComponent(value);
}
