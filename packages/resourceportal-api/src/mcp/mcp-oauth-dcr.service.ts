import { BadGatewayException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

type DcrResult = {
  status: number;
  contentType: string;
  body: string;
};

type DcrRegistrationResponse = {
  client_id?: string;
  registration_access_token?: string;
  registration_client_uri?: string;
};

type ProjectSearchResponse = {
  result?: Array<{ id?: string; name?: string }>;
  details?: { totalResult?: number | string };
};

type DcrOidcConfig = {
  responseTypes: string[];
  grantTypes: string[];
};

type ExactDcrApp = { id: string; oidcConfig: DcrOidcConfig };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every(item => typeof item === "string" && item.length > 0);
}

/** Positive matches require an explicit total; protobuf omits a zero total. */
function readSearchTotal(details: unknown): number | null {
  if (!isRecord(details)) return null;
  const raw = details.totalResult;
  if (raw === undefined) return 0;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && !/^\d+$/.test(raw)) return null;
  const total = Number(raw);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

@Injectable()
export class McpOAuthDcrService {
  constructor(private readonly config: ConfigService) {}

  async register(metadata: unknown, authorization?: string): Promise<DcrResult> {
    const deadline = Date.now() + this.registrationTimeoutMs();
    // Validate local configuration before treating a dispatched registration
    // POST as potentially accepted by the issuer.
    const timeoutMs = this.requestTimeoutMs(deadline);
    const registerUrl = `${this.internalUrl()}/oauth/v2/register`;
    const issuerHost = this.issuerHost();
    const requestBody = JSON.stringify(metadata ?? {});
    let response: Response;
    try {
      response = await this.upstreamFetch(registerUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      method: "POST",
      // The DCR registration request can include an OAuth Authorization
      // header supplied by the client. Never let an upstream redirect
      // forward that credential to an unrelated endpoint or issuer path.
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-zitadel-instance-host": issuerHost,
        "x-zitadel-public-host": issuerHost,
        ...(authorization ? { authorization } : {}),
      },
      body: requestBody,
      });
    } catch {
      // The POST may have reached ZITADEL and committed a client before a
      // timeout, connection reset or lost response. Never imply that a blind
      // retry is guaranteed safe when no registration ID can be recovered.
      throw this.uncertainRegistration();
    }
    let body: string;
    try {
      body = await boundedDcrResponseText(response);
    } catch (error) {
      // HTTP 201 can already have created a ZITADEL client even when the
      // response body is truncated, oversized or unreadable. Without the
      // registration ID/rollback credential, deletion cannot be verified.
      if (response.status === 201) throw this.uncertainRegistration();
      if (error instanceof BadGatewayException) throw error;
      // A non-201 upstream response may also stall after headers. Do not
      // expose an unhandled AbortError or an upstream response body to callers.
      throw new BadGatewayException("ZITADEL DCR upstream response unavailable or timed out");
    }
    const contentType = response.headers.get("content-type") ?? "application/json";

    if (response.status !== 201) {
      return { status: response.status, contentType, body };
    }

    let registration: DcrRegistrationResponse & { client_id: string };
    try {
      registration = this.parseRegistration(body);
    } catch {
      // Never retry blindly after a successful upstream registration whose
      // response cannot be parsed: a partial OAuth client can remain orphaned.
      throw this.uncertainRegistration();
    }
    try {
      await this.forceJwtAccessToken(registration.client_id, deadline);
    } catch (error) {
      try {
        await this.rollbackRegistration(registration);
      } catch {
        // A failed compensation leaves a real OAuth client in ZITADEL. Do
        // not conceal that partial state by rethrowing only the update error.
        // Expose the client id (never the registration bearer/URI) so an
        // operator can locate and remove it before retrying registration.
        const clientId = /^[a-zA-Z0-9._~-]{1,128}$/.test(registration.client_id)
          ? registration.client_id : "(inspect ZITADEL registration records)";
        throw new BadGatewayException({
          code: "DCR_PARTIAL_REGISTRATION",
          message: "ZITADEL DCR compatibility update failed and cleanup of the newly registered client could not be confirmed; manual reconciliation is required before retrying",
          clientId,
        });
      }
      throw error;
    }

    return { status: response.status, contentType, body };
  }

  private uncertainRegistration() {
    return new BadGatewayException({
      code: "DCR_REGISTRATION_OUTCOME_UNCERTAIN",
      message: "ZITADEL OAuth client registration may have been accepted but its outcome or rollback credentials could not be verified; reconcile upstream clients before retrying",
    });
  }

  private parseRegistration(body: string): DcrRegistrationResponse & { client_id: string } {
    let registration: DcrRegistrationResponse;
    try {
      registration = JSON.parse(body) as DcrRegistrationResponse;
    } catch {
      throw new BadGatewayException("ZITADEL DCR returned invalid JSON");
    }
    // An accepted upstream registration may be unidentifiable when client_id
    // is not the expected bounded URI-path-safe scalar. Never attempt a
    // management mutation or compensating DELETE against a coerced value.
    if (typeof registration.client_id !== "string" ||
        !/^[a-zA-Z0-9._~-]{1,128}$/.test(registration.client_id)) {
      throw new BadGatewayException("ZITADEL DCR response did not include a valid client_id");
    }
    return registration as DcrRegistrationResponse & { client_id: string };
  }

  private async forceJwtAccessToken(clientId: string, deadline: number) {
    const projectId = await this.findDcrProjectId(deadline);
    const app = await this.findDcrApp(projectId, clientId, deadline);
    const responseTypes = app.oidcConfig?.responseTypes;
    const grantTypes = app.oidcConfig?.grantTypes;
    if (!responseTypes?.length || !grantTypes?.length) {
      throw new BadGatewayException(
        "ZITADEL DCR application OAuth configuration was incomplete after registration",
      );
    }
    await this.managementRequest(
      "POST",
      "/zitadel.application.v2.ApplicationService/UpdateApplication",
      {
        applicationId: app.id,
        projectId,
        oidcConfiguration: {
          responseTypes,
          grantTypes,
          accessTokenType: "OIDC_TOKEN_TYPE_JWT",
        },
      },
      { "connect-protocol-version": "1" },
      deadline,
    );
  }

  private async findDcrProjectId(deadline: number) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const projects = await this.managementRequest<ProjectSearchResponse>(
        "POST",
        "/management/v1/projects/_search",
        {
          query: { limit: 100 },
          queries: [{ nameQuery: {
            name: "ZITADEL DCR", method: "TEXT_QUERY_METHOD_EQUALS",
          } }],
        },
        {},
        deadline,
      );
      const total = readSearchTotal(projects.details);
      const matches = projects.result === undefined ? [] : projects.result;
      if (total === null || !Array.isArray(matches) || total > 1 || matches.length > 1) {
        throw new BadGatewayException("ZITADEL DCR project search was ambiguous");
      }
      if (total === 1 && matches.length === 1) {
        const project: unknown = matches[0];
        if (!isRecord(project) || project.name !== "ZITADEL DCR" ||
            typeof project.id !== "string" || !project.id) {
          throw new BadGatewayException("ZITADEL DCR project search returned an untrusted identity");
        }
        return project.id;
      }
      if (total !== 0 || matches.length !== 0) {
        throw new BadGatewayException("ZITADEL DCR project search was incomplete");
      }
      await sleep(100);
    }
    throw new BadGatewayException("ZITADEL DCR project was not visible after registration");
  }

  private async findDcrApp(projectId: string, clientId: string, deadline: number): Promise<ExactDcrApp> {
    // The pinned ZITADEL ApplicationService V2 implements exact project/client
    // filters combined with AND. Query only the newly registered identity,
    // never a global inventory page. Limit two detects ambiguity independently
    // of unrelated registrations and provider inventory churn.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await this.managementRequest<Record<string, unknown>>(
        "POST",
        "/zitadel.application.v2.ApplicationService/ListApplications",
        {
          pagination: { limit: 2 },
          filters: [
            { projectIdFilter: { projectId } },
            { clientIdFilter: { clientId } },
          ],
        },
        { "connect-protocol-version": "1" },
        deadline,
      );
      const total = readSearchTotal(response.pagination);
      const applications = response.applications === undefined ? [] : response.applications;
      if (total === null || !Array.isArray(applications) || applications.length > 2) {
        throw new BadGatewayException("ZITADEL DCR application search was invalid");
      }
      if (total > 1 || applications.length > 1) {
        throw new BadGatewayException("ZITADEL DCR application search was ambiguous");
      }
      if (total === 0 && applications.length === 0) {
        // Zero (including omitted proto3 zero) is normal until projection.
        // Retry only this read, within the original registration deadline.
        await sleep(100);
        continue;
      }
      if (total !== 1 || applications.length !== 1) {
        throw new BadGatewayException("ZITADEL DCR application search was incomplete");
      }
      const app: unknown = applications[0];
      if (!isRecord(app) || typeof app.applicationId !== "string" || !app.applicationId ||
          app.projectId !== projectId || app.state !== "APPLICATION_STATE_ACTIVE" ||
          !isRecord(app.oidcConfiguration) || app.oidcConfiguration.clientId !== clientId) {
        throw new BadGatewayException("ZITADEL DCR application search returned an untrusted identity");
      }
      const { responseTypes, grantTypes } = app.oidcConfiguration;
      if (!isStringList(responseTypes) || !isStringList(grantTypes)) {
        throw new BadGatewayException("ZITADEL DCR application OAuth configuration was incomplete after registration");
      }
      return { id: app.applicationId, oidcConfig: { responseTypes, grantTypes } };
    }
    throw new BadGatewayException("ZITADEL DCR application was not visible after registration");
  }

  private async managementRequest<T>(
    method: "POST" | "PUT",
    path: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
    deadline = Date.now() + 30_000,
  ): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new BadGatewayException("ZITADEL DCR registration exceeded deadline");
    const response = await this.upstreamFetch(`${this.internalUrl()}${path}`, {
      signal: AbortSignal.timeout(this.requestTimeoutMs(deadline)),
      method,
      // Management Bearer must never traverse redirects to another endpoint.
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.managementToken()}`,
        "content-type": "application/json",
        "x-zitadel-instance-host": this.issuerHost(),
        "x-zitadel-public-host": this.issuerHost(),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    let text: string;
    try {
      text = await boundedDcrResponseText(response);
    } catch (error) {
      // A stalled/truncated management stream may abort only after fetch()
      // has already returned headers. Never leak raw upstream diagnostics.
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException("ZITADEL DCR upstream response unavailable or timed out");
    }
    if (!response.ok) {
      throw new BadGatewayException(
        `ZITADEL DCR compatibility update failed with HTTP ${response.status}`,
      );
    }
    // ZITADEL response bodies can contain sensitive diagnostics. Never pass a
    // raw SyntaxError message (which may include the invalid JSON snippet)
    // to OAuth callers. Preserve compensation for a newly registered client.
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Unexpected management response shape");
      }
      return parsed as T;
    } catch {
      throw new BadGatewayException("ZITADEL DCR management response was invalid");
    }
  }

  private async rollbackRegistration(registration: DcrRegistrationResponse) {
    if (!registration.registration_access_token || !registration.registration_client_uri) {
      throw new BadGatewayException("ZITADEL DCR rollback credentials were missing");
    }
    let url: URL;
    try {
      url = new URL(registration.registration_client_uri);
    } catch {
      throw new BadGatewayException("ZITADEL DCR rollback URI was invalid");
    }
    // Registration metadata is returned by the upstream. Restrict which
    // internal endpoint is contacted and never send its bearer to an
    // unrelated management path or a URL with embedded credentials.
    // On an HTTPS issuer behind a TLS-terminating ingress, actual ZITADEL
    // may advertise an http:// issuer-host registration_client_uri. This
    // metadata is only a locator: never fetch that URI. Rebuild the rollback
    // request against the configured internal ZITADEL origin, restrict its
    // path and issuer host, and retain the per-registration Bearer only there.
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        url.host !== this.issuerHost() ||
        url.username || url.password || url.search || url.hash ||
        !/^\/oauth\/v2\/register\/[a-zA-Z0-9._~-]+$/.test(url.pathname) ||
        url.pathname !== `/oauth/v2/register/${registration.client_id}`) {
      throw new BadGatewayException("ZITADEL DCR rollback URI was not trusted");
    }
    const response = await this.upstreamFetch(`${this.internalUrl()}${url.pathname}`, {
      signal: AbortSignal.timeout(this.requestTimeoutMs()),
      method: "DELETE",
      // A redirect can forward this registration-scoped Bearer to another
      // endpoint (including another path on the same issuer). Never follow it.
      redirect: "error",
      headers: {
        authorization: `Bearer ${registration.registration_access_token}`,
        "x-zitadel-instance-host": this.issuerHost(),
        "x-zitadel-public-host": this.issuerHost(),
      },
    });
    if (response.status !== 204) {
      throw new BadGatewayException(`ZITADEL DCR rollback failed with HTTP ${response.status}`);
    }
    // A DELETE 204 confirms the command was accepted, not that the RFC7592
    // client projection stopped serving the prior registration bearer. In
    // ZITADEL v4.17.0 the eventstore removal and read projection are distinct.
    // Use the *same exact-client bearer* to prove GET404 before reporting a
    // successful compensation. Never treat 401/403 as proof of removal.
    const deadline = Date.now() + this.requestTimeoutMs();
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new BadGatewayException("ZITADEL DCR rollback could not verify client absence before deadline");
      }
      const check = await this.upstreamFetch(`${this.internalUrl()}${url.pathname}`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(this.requestTimeoutMs(), remaining))),
        method: "GET",
        redirect: "error",
        headers: {
          authorization: `Bearer ${registration.registration_access_token}`,
          "x-zitadel-instance-host": this.issuerHost(),
          "x-zitadel-public-host": this.issuerHost(),
        },
      });
      // Avoid buffering or exposing provider bodies containing private data.
      // A broken body cancellation must not extend the rollback deadline.
      void check.body?.cancel().catch(() => undefined);
      if (check.status === 404) return;
      if (check.status !== 200) {
        throw new BadGatewayException(
          `ZITADEL DCR rollback verification failed with HTTP ${check.status}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new BadGatewayException("ZITADEL DCR rollback client remained accessible");
      }
      await sleep(Math.min(100, deadline - Date.now()));
    }
  }

  /** Do not expose upstream transport exception messages, URLs or credentials to DCR callers. */
  private async upstreamFetch(url: string, options: RequestInit): Promise<Response> {
    try {
      return await fetch(url, options);
    } catch {
      // fetch() can reject with arbitrary provider/transport exceptions,
      // including non-standard errors containing private headers or URLs.
      // Never let any such exception escape into OAuth responses or logs.
      throw new BadGatewayException("ZITADEL DCR upstream request unavailable or timed out");
    }
  }

  /** Keep operator overrides bounded even if the environment is misconfigured. */
  private registrationTimeoutMs(): number {
    return this.boundedTimeout("ZITADEL_DCR_REGISTRATION_TIMEOUT_MS", 30_000, 1_000, 120_000);
  }

  private requestTimeoutMs(deadline?: number): number {
    const configured = this.boundedTimeout("ZITADEL_DCR_REQUEST_TIMEOUT_MS", 10_000, 500, 30_000);
    if (deadline === undefined) return configured;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new BadGatewayException("ZITADEL DCR registration exceeded deadline");
    }
    return Math.max(1, Math.min(configured, remaining));
  }

  private boundedTimeout(key: string, fallback: number, minimum: number, maximum: number): number {
    const value = this.config.get<string>(key);
    if (value === undefined || value === "") return fallback;
    if (!/^[0-9]+$/.test(String(value))) {
      throw new ServiceUnavailableException(`${key} must be a positive integer in milliseconds`);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
      throw new ServiceUnavailableException(`${key} must be between ${minimum} and ${maximum} milliseconds`);
    }
    return number;
  }

  private internalUrl() {
    return (this.config.get<string>("ZITADEL_INTERNAL_URL") ?? "http://zitadel:8080").replace(
      /\/$/,
      "",
    );
  }

  private issuer() {
    const issuer = this.config.get<string>("OIDC_ISSUER_URL");
    if (!issuer) throw new ServiceUnavailableException("OIDC_ISSUER_URL is required");
    return issuer.replace(/\/$/, "");
  }

  private issuerHost() {
    return new URL(this.issuer()).host;
  }

  private managementToken() {
    const token = this.config.get<string>("ZITADEL_MANAGEMENT_TOKEN");
    if (!token) {
      throw new ServiceUnavailableException("ZITADEL_MANAGEMENT_TOKEN is required for MCP DCR");
    }
    return token;
  }

}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Limit successful and unsuccessful Zitadel response bodies before buffering. */
async function boundedDcrResponseText(response: Response): Promise<string> {
  const maxBytes = 1_048_576;
  const expectedSize = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(expectedSize) && expectedSize > maxBytes) {
    throw new BadGatewayException("ZITADEL DCR response exceeded size limit");
  }
  if (!response.body) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // A malicious/failed upstream stream may never resolve cancel().
        // Fail closed immediately rather than hanging past the request bound.
        void reader.cancel().catch(() => undefined);
        throw new BadGatewayException("ZITADEL DCR response exceeded size limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    reader.releaseLock();
  }
}
