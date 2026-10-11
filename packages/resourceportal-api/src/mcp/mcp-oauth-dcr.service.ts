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
};

type DcrOidcConfig = {
  clientId?: string;
  responseTypes?: string[];
  grantTypes?: string[];
};

type AppSearchResponse = {
  result?: Array<{ id?: string; oidcConfig?: DcrOidcConfig }>;
};

@Injectable()
export class McpOAuthDcrService {
  constructor(private readonly config: ConfigService) {}

  async register(metadata: unknown, authorization?: string): Promise<DcrResult> {
    const deadline = Date.now() + 30_000;
    const response = await fetch(`${this.internalUrl()}/oauth/v2/register`, {
      signal: AbortSignal.timeout(10_000),
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zitadel-instance-host": this.issuerHost(),
        "x-zitadel-public-host": this.issuerHost(),
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(metadata ?? {}),
    });
    const body = await boundedDcrResponseText(response);
    const contentType = response.headers.get("content-type") ?? "application/json";

    if (response.status !== 201) {
      return { status: response.status, contentType, body };
    }

    const registration = this.parseRegistration(body);
    try {
      await this.forceJwtAccessToken(registration.client_id, deadline);
    } catch (error) {
      await this.rollbackRegistration(registration).catch(() => undefined);
      throw error;
    }

    return { status: response.status, contentType, body };
  }

  private parseRegistration(body: string): DcrRegistrationResponse & { client_id: string } {
    let registration: DcrRegistrationResponse;
    try {
      registration = JSON.parse(body) as DcrRegistrationResponse;
    } catch {
      throw new BadGatewayException("ZITADEL DCR returned invalid JSON");
    }
    if (!registration.client_id) {
      throw new BadGatewayException("ZITADEL DCR response did not include client_id");
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
        {},
        {},
        deadline,
      );
      const project = projects.result?.find((candidate) => candidate.name === "ZITADEL DCR");
      if (project?.id) return project.id;
      await sleep(100);
    }
    throw new BadGatewayException("ZITADEL DCR project was not visible after registration");
  }

  private async findDcrApp(projectId: string, clientId: string, deadline: number) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const apps = await this.managementRequest<AppSearchResponse>(
        "POST",
        `/management/v1/projects/${encodeURIComponent(projectId)}/apps/_search`,
        {},
        {},
        deadline,
      );
      const app = apps.result?.find((candidate) => candidate.oidcConfig?.clientId === clientId);
      if (app?.id) return app as typeof app & { id: string };
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
    const response = await fetch(`${this.internalUrl()}${path}`, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remainingMs))),
      method,
      headers: {
        authorization: `Bearer ${this.managementToken()}`,
        "content-type": "application/json",
        "x-zitadel-instance-host": this.issuerHost(),
        "x-zitadel-public-host": this.issuerHost(),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const text = await boundedDcrResponseText(response);
    if (!response.ok) {
      throw new BadGatewayException(
        `ZITADEL DCR compatibility update failed with HTTP ${response.status}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async rollbackRegistration(registration: DcrRegistrationResponse) {
    if (!registration.registration_access_token || !registration.registration_client_uri) return;
    const path = new URL(registration.registration_client_uri).pathname;
    await fetch(`${this.internalUrl()}${path}`, {
      signal: AbortSignal.timeout(10_000),
      method: "DELETE",
      headers: {
        authorization: `Bearer ${registration.registration_access_token}`,
        "x-zitadel-instance-host": this.issuerHost(),
        "x-zitadel-public-host": this.issuerHost(),
      },
    });
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
        await reader.cancel();
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
