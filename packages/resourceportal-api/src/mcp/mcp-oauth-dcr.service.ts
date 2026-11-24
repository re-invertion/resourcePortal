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
  clientId?: string;
  responseTypes?: string[];
  grantTypes?: string[];
};

type AppSearchResponse = {
  result?: Array<{ id?: string; oidcConfig?: DcrOidcConfig }>;
  details?: { totalResult?: number | string };
};

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
      const matches = (projects.result ?? []).filter((candidate) =>
        candidate.name === "ZITADEL DCR" && Boolean(candidate.id));
      const rawTotal = projects.details?.totalResult;
      const total = rawTotal === undefined ? matches.length : Number(rawTotal);
      if (matches.length > 1 || total > 1 || !Number.isSafeInteger(total)) {
        throw new BadGatewayException("ZITADEL DCR project search was ambiguous");
      }
      const project = matches[0];
      if (project?.id) return project.id;
      await sleep(100);
    }
    throw new BadGatewayException("ZITADEL DCR project was not visible after registration");
  }

  private async findDcrApp(projectId: string, clientId: string, deadline: number) {
    // ListApps defaults to 100 results. Polling only the first page retries
    // the wrong set forever as more DCR clients accumulate. Page through the
    // bounded result set while honoring the existing registration deadline.
    const pageSize = 100;
    const maxPages = 20;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let match: NonNullable<AppSearchResponse["result"]>[number] | undefined;
      let complete = false;
      for (let page = 0; page < maxPages; page += 1) {
        const offset = page * pageSize;
        const apps = await this.managementRequest<AppSearchResponse>(
          "POST",
          `/management/v1/projects/${encodeURIComponent(projectId)}/apps/_search`,
          { query: { limit: pageSize, offset } },
          {},
          deadline,
        );
        // DCR client IDs are supposed to be unique, but do not trust a
        // single page: validate the entire bounded project search before
        // modifying any upstream application.
        const results = apps.result ?? [];
        if (!Array.isArray(results) || results.length > pageSize) {
          throw new BadGatewayException("ZITADEL DCR application search returned invalid page");
        }
        for (const candidate of results) {
          if (candidate.oidcConfig?.clientId !== clientId) continue;
          if (!candidate.id || match) {
            throw new BadGatewayException("ZITADEL DCR application search was ambiguous");
          }
          match = candidate;
        }
        // The projection can advertise a total before its records exist.
        // Retry an empty page instead of accepting a partial snapshot.
        if (results.length === 0) break;
        const rawTotal = apps.details?.totalResult;
        const parsed = Number(rawTotal);
        const total = rawTotal !== undefined && Number.isSafeInteger(parsed) && parsed >= 0
          ? parsed : null;
        if (results.length < pageSize || (total !== null && offset + results.length >= total)) {
          if (total !== null && offset + results.length < total) {
            throw new BadGatewayException("ZITADEL DCR application search was incomplete");
          }
          complete = true;
          break;
        }
      }
      if (!complete && match) {
        throw new BadGatewayException("ZITADEL DCR application search was incomplete");
      }
      if (match?.id && complete) return match as typeof match & { id: string };
      await sleep(100);
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
