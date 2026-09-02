export type ApiErrorPayload = {
  code?: string;
  message?: string | string[];
  details?: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly correlationId?: string;

  constructor(input: {
    status: number;
    message: string;
    code?: string;
    details?: unknown;
    requestId?: string;
    correlationId?: string;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
    this.requestId = input.requestId;
    this.correlationId = input.correlationId;
  }
}

export type ApiRequestInit = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
};

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function readCsrfToken(cookieHeader = document.cookie): string | undefined {
  for (const item of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = item.trim().split("=");
    if (rawName === "rp_csrf") {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return undefined;
}

function isNativeBody(value: unknown): value is BodyInit {
  return typeof value === "string" ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value);
}

function normalizeMessage(value: unknown, fallback: string) {
  if (Array.isArray(value)) return value.map(String).join("; ");
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

async function decodeBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response.json();
  const text = await response.text();
  return text.length > 0 ? text : undefined;
}

export async function apiRequest<T = unknown>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  let body = init.body;

  if (body != null && !isNativeBody(body)) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(body);
  }

  if (unsafeMethods.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers.set("x-csrf-token", csrf);
  }

  const response = await fetch(path, {
    ...init,
    method,
    body: body as BodyInit | null | undefined,
    credentials: "same-origin",
    headers,
  });

  const payload = await decodeBody(response);
  if (!response.ok) {
    const envelope = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const nested = envelope.error && typeof envelope.error === "object"
      ? envelope.error as ApiErrorPayload
      : envelope as ApiErrorPayload;
    throw new ApiError({
      status: response.status,
      code: nested.code,
      message: normalizeMessage(nested.message, response.statusText || `HTTP ${response.status}`),
      details: nested.details,
      requestId: typeof envelope.requestId === "string" ? envelope.requestId : response.headers.get("x-request-id") ?? undefined,
      correlationId: typeof envelope.correlationId === "string" ? envelope.correlationId : response.headers.get("x-correlation-id") ?? undefined,
    });
  }

  return payload as T;
}

export function apiPath(path: string) {
  return path.startsWith("/api/") ? path : `/api${path.startsWith("/") ? path : `/${path}`}`;
}
