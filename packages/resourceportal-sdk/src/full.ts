import {
  ResourcePortalApiError as BaseResourcePortalApiError,
  ResourcePortalClient as BaseResourcePortalClient,
  ResourcePortalClientOptions as BaseResourcePortalClientOptions,
  ResourcePortalRequestOptions as BaseResourcePortalRequestOptions,
} from "./index";

export * from "./index";

export type ResourcePortalQueryPrimitive = string | number | boolean;
export type ResourcePortalQuery = Record<
  string,
  | ResourcePortalQueryPrimitive
  | ResourcePortalQueryPrimitive[]
  | null
  | undefined
>;

export type ResourcePortalClientOptions = BaseResourcePortalClientOptions & {
  correlationId?: string;
  requestId?: string;
};

export type ResourcePortalRequestOptions = BaseResourcePortalRequestOptions & {
  correlationId?: string;
  query?: ResourcePortalQuery;
  requestId?: string;
  responseType?: "auto" | "json" | "text";
};

export class ResourcePortalApiError extends BaseResourcePortalApiError {
  readonly code?: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly correlationId?: string;

  constructor(
    message: string,
    status: number,
    payload: unknown,
    headers?: Headers,
  ) {
    super(message, status, payload);
    const root = asRecord(payload);
    const error = asRecord(root?.error);

    this.code = stringValue(error?.code) ?? stringValue(root?.code);
    this.details = error?.details ?? root?.details;
    this.requestId =
      stringValue(error?.requestId) ??
      stringValue(root?.requestId) ??
      headers?.get("x-request-id") ??
      undefined;
    this.correlationId =
      stringValue(error?.correlationId) ??
      stringValue(root?.correlationId) ??
      headers?.get("x-correlation-id") ??
      undefined;
  }
}

export class ResourcePortalClient extends BaseResourcePortalClient {
  readonly platformBilling = {
    listPriceLists: () => this.request("/platform/billing/price-lists"),
    getPriceList: (priceListId: string) =>
      this.request(`/platform/billing/price-lists/${encode(priceListId)}`),
    createPriceList: (body: unknown) =>
      this.request("/platform/billing/price-lists", { method: "POST", body }),
    listVouchers: () => this.request("/platform/billing/vouchers"),
    getVoucher: (voucherId: string) =>
      this.request(`/platform/billing/vouchers/${encode(voucherId)}`),
    createVoucher: (body: unknown) =>
      this.request("/platform/billing/vouchers", { method: "POST", body }),
    disableVoucher: (voucherId: string) =>
      this.request(`/platform/billing/vouchers/${encode(voucherId)}/disable`, {
        method: "POST",
      }),
    payment: (body: unknown) =>
      this.request("/platform/billing/payments", { method: "POST", body }),
    refund: (body: unknown) =>
      this.request("/platform/billing/refunds", { method: "POST", body }),
    correction: (body: unknown) =>
      this.request("/platform/billing/corrections", { method: "POST", body }),
  };

  readonly platformInfrastructure = {
    getSwarmCluster: () => this.request("/platform/swarm-cluster"),
    reconcileSwarmCluster: () =>
      this.request("/platform/swarm-cluster/reconcile", { method: "POST" }),
    listRemoteLocations: () => this.request("/platform/remote-locations"),
    getRemoteLocation: (remoteLocationId: string) =>
      this.request(`/platform/remote-locations/${encode(remoteLocationId)}`),
    setRemoteLocationMaintenance: (
      remoteLocationId: string,
      enabled: boolean,
    ) =>
      this.request(
        `/platform/remote-locations/${encode(remoteLocationId)}/maintenance`,
        { method: "PATCH", body: { enabled } },
      ),
  };

  readonly storageBackends = {
    list: () => this.request("/platform/storage-backends"),
    get: (storageBackendId: string) =>
      this.request(`/platform/storage-backends/${encode(storageBackendId)}`),
    validate: (storageBackendId: string) =>
      this.request(
        `/platform/storage-backends/${encode(storageBackendId)}/validate`,
        { method: "POST" },
      ),
    setMaintenance: (storageBackendId: string, enabled: boolean) =>
      this.request(
        `/platform/storage-backends/${encode(storageBackendId)}/maintenance`,
        { method: "PATCH", body: { enabled } },
      ),
  };

  readonly operations = {
    list: (tenantId: string) =>
      this.request(`/tenants/${encode(tenantId)}/operations`),
    get: (tenantId: string, operationId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/operations/${encode(operationId)}`,
      ),
    events: (tenantId: string, operationId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/operations/${encode(operationId)}/events`,
      ),
    retry: (tenantId: string, operationId: string) =>
      this.request(
        `/tenants/${encode(tenantId)}/operations/${encode(operationId)}/retry`,
        { method: "POST" },
      ),
  };

  readonly platformMaintenance = {
    get: () => this.request("/platform/maintenance"),
    set: (body: unknown) =>
      this.request("/platform/maintenance", { method: "PATCH", body }),
  };

  readonly oauthApplications = tenantCredentialCollection(
    this,
    "oauth-applications",
  );

  readonly platformOauthApplications = platformCredentialCollection(
    this,
    "oauth-applications",
  );

  readonly serviceIdentities = tenantCredentialCollection(
    this,
    "service-identities",
  );

  readonly platformServiceIdentities = platformCredentialCollection(
    this,
    "service-identities",
  );

  readonly platformIdentityProviders = {
    list: () => this.request("/platform/identity-providers"),
    get: (identityProviderId: string) =>
      this.request(`/platform/identity-providers/${encode(identityProviderId)}`),
    create: (body: unknown) =>
      this.request("/platform/identity-providers", { method: "POST", body }),
    update: (identityProviderId: string, body: unknown) =>
      this.request(`/platform/identity-providers/${encode(identityProviderId)}`, {
        method: "PATCH",
        body,
      }),
    delete: (identityProviderId: string) =>
      this.request(`/platform/identity-providers/${encode(identityProviderId)}`, {
        method: "DELETE",
      }),
  };

  readonly metrics = {
    get: () =>
      this.request<string>("/metrics", {
        responseType: "text",
      }),
  };

  override readonly auditLog = {
    list: (tenantId: string, query?: ResourcePortalQuery) =>
      this.request(`/tenants/${encode(tenantId)}/audit-log`, { query }),
    export: (tenantId: string, query?: ResourcePortalQuery) =>
      this.request<string>(`/tenants/${encode(tenantId)}/audit-log/export`, {
        query,
        responseType: "text",
      }),
  };

  private readonly compatibilityApiUrl: string;
  private readonly compatibilityDevUserId?: string;
  private readonly compatibilityToken?: string;
  private readonly compatibilityCorrelationId?: string;
  private readonly compatibilityRequestId?: string;
  private readonly compatibilityFetchImpl: typeof fetch;

  constructor(options: ResourcePortalClientOptions) {
    super(options);
    this.compatibilityApiUrl = options.apiUrl.replace(/\/$/, "");
    this.compatibilityDevUserId = options.devUserId;
    this.compatibilityToken = options.token;
    this.compatibilityCorrelationId =
      options.correlationId ?? environmentValue("RESOURCE_PORTAL_CORRELATION_ID");
    this.compatibilityRequestId =
      options.requestId ?? environmentValue("RESOURCE_PORTAL_REQUEST_ID");
    this.compatibilityFetchImpl = options.fetchImpl ?? fetch;
  }

  override async request<T = unknown>(
    path: string,
    options: ResourcePortalRequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.compatibilityApiUrl}${path}`);
    appendQuery(url, options.query);

    const response = await this.compatibilityFetchImpl(url.toString(), {
      method: options.method ?? "GET",
      headers: {
        ...(this.compatibilityToken
          ? { authorization: `Bearer ${this.compatibilityToken}` }
          : {}),
        ...(this.compatibilityDevUserId
          ? { "x-dev-user-id": this.compatibilityDevUserId }
          : {}),
        ...(options.idempotencyKey
          ? { "idempotency-key": options.idempotencyKey }
          : {}),
        ...(options.correlationId ?? this.compatibilityCorrelationId
          ? {
              "x-correlation-id":
                options.correlationId ?? this.compatibilityCorrelationId!,
            }
          : {}),
        ...(options.requestId ?? this.compatibilityRequestId
          ? { "x-request-id": options.requestId ?? this.compatibilityRequestId! }
          : {}),
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    const payload = parsePayload(text, response.headers, options.responseType);

    if (!response.ok) {
      throw new ResourcePortalApiError(
        errorMessage(payload) ??
          `Resource Portal API request failed with HTTP ${response.status}`,
        response.status,
        payload,
        response.headers,
      );
    }

    return payload as T;
  }
}

function tenantCredentialCollection(
  client: ResourcePortalClient,
  resource: "oauth-applications" | "service-identities",
) {
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
    rotateCredentials: (tenantId: string, resourceId: string) =>
      client.request(
        `/tenants/${encode(tenantId)}/${resource}/${encode(resourceId)}/rotate-credentials`,
        { method: "POST" },
      ),
    delete: (tenantId: string, resourceId: string) =>
      client.request(
        `/tenants/${encode(tenantId)}/${resource}/${encode(resourceId)}`,
        { method: "DELETE" },
      ),
  };
}

function platformCredentialCollection(
  client: ResourcePortalClient,
  resource: "oauth-applications" | "service-identities",
) {
  return {
    list: () => client.request(`/platform/${resource}`),
    get: (resourceId: string) =>
      client.request(`/platform/${resource}/${encode(resourceId)}`),
    create: (body: unknown) =>
      client.request(`/platform/${resource}`, { method: "POST", body }),
    update: (resourceId: string, body: unknown) =>
      client.request(`/platform/${resource}/${encode(resourceId)}`, {
        method: "PATCH",
        body,
      }),
    rotateCredentials: (resourceId: string) =>
      client.request(
        `/platform/${resource}/${encode(resourceId)}/rotate-credentials`,
        { method: "POST" },
      ),
    delete: (resourceId: string) =>
      client.request(`/platform/${resource}/${encode(resourceId)}`, {
        method: "DELETE",
      }),
  };
}

function appendQuery(url: URL, query?: ResourcePortalQuery) {
  if (!query) return;

  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === null) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      url.searchParams.append(key, String(value));
    }
  }
}

function parsePayload(
  text: string,
  headers: Headers,
  responseType: ResourcePortalRequestOptions["responseType"] = "auto",
): unknown {
  if (responseType === "text") return text;
  if (!text) return null;

  const contentType = headers.get("content-type") ?? "";
  const trimmed = text.trim();
  const shouldParseJson =
    responseType === "json" ||
    contentType.toLowerCase().includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");

  return shouldParseJson ? JSON.parse(text) : text;
}

function errorMessage(payload: unknown) {
  const root = asRecord(payload);
  const error = asRecord(root?.error);
  return stringValue(error?.message) ?? stringValue(root?.message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function environmentValue(name: string) {
  return typeof process === "undefined" ? undefined : process.env[name];
}

function encode(value: string) {
  return encodeURIComponent(value);
}
