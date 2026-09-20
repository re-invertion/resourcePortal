import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { CLOUDFLARE_MANAGED_RECORD_COMMENT } from "./platform-dns.constants";

type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
};

type CloudflareZone = {
  id: string;
  name: string;
  status?: string;
};

type CloudflareToken = {
  id: string;
  status: string;
};

export type CloudflareDnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  comment?: string | null;
};

export class CloudflareApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

@Injectable()
export class CloudflareDnsService {
  private readonly apiBase = "https://api.cloudflare.com/client/v4";

  async validateConnection(input: {
    apiToken: string;
    zoneId: string;
    managedBaseDomain: string;
  }) {
    const token = await this.request<CloudflareToken>(
      "/user/tokens/verify",
      input.apiToken,
    );
    if (token.status !== "active") {
      throw new CloudflareApiError(
        `Cloudflare API token is ${token.status || "not active"}`,
      );
    }

    const zone = await this.request<CloudflareZone>(
      `/zones/${encodeURIComponent(input.zoneId)}`,
      input.apiToken,
    );
    const zoneName = normalizeHostname(zone.name);
    const managedBaseDomain = normalizeHostname(input.managedBaseDomain);
    if (
      managedBaseDomain !== zoneName &&
      !managedBaseDomain.endsWith(`.${zoneName}`)
    ) {
      throw new CloudflareApiError(
        `Managed ResourcePortal domain ${managedBaseDomain} is outside Cloudflare zone ${zoneName}`,
      );
    }
    if (zone.status && zone.status !== "active") {
      throw new CloudflareApiError(
        `Cloudflare zone ${zoneName} is ${zone.status}, not active`,
      );
    }

    await this.verifyDnsWrite(input.apiToken, input.zoneId, managedBaseDomain);
    return { zoneId: zone.id, zoneName };
  }

  async ensureManagedCname(input: {
    apiToken: string;
    zoneId: string;
    hostname: string;
    targetHostname: string;
  }) {
    const hostname = normalizeHostname(input.hostname);
    const targetHostname = normalizeHostname(input.targetHostname);
    const records = await this.listRecords(input.apiToken, input.zoneId, hostname);
    const owned = records.find(
      (record) =>
        record.type === "CNAME" &&
        normalizeHostname(record.name) === hostname &&
        normalizeHostname(record.content) === targetHostname &&
        record.comment === CLOUDFLARE_MANAGED_RECORD_COMMENT,
    );
    if (owned) return { record: owned, created: false };
    if (records.length > 0) {
      throw new CloudflareApiError(
        `Cloudflare already has a DNS record for ${hostname}; ResourcePortal will not overwrite an unmanaged record`,
      );
    }

    const record = await this.createRecord(input.apiToken, input.zoneId, {
      type: "CNAME",
      name: hostname,
      content: targetHostname,
      ttl: 1,
      proxied: false,
      comment: CLOUDFLARE_MANAGED_RECORD_COMMENT,
    });
    return { record, created: true };
  }

  async deleteManagedCname(input: {
    apiToken: string;
    zoneId: string;
    hostname: string;
    targetHostname: string;
  }) {
    const hostname = normalizeHostname(input.hostname);
    const targetHostname = normalizeHostname(input.targetHostname);
    const records = await this.listRecords(input.apiToken, input.zoneId, hostname);
    const owned = records.filter(
      (record) =>
        record.type === "CNAME" &&
        normalizeHostname(record.name) === hostname &&
        normalizeHostname(record.content) === targetHostname &&
        record.comment === CLOUDFLARE_MANAGED_RECORD_COMMENT,
    );
    for (const record of owned) {
      await this.deleteRecord(input.apiToken, input.zoneId, record.id);
    }
    return { deleted: owned.length };
  }

  async hasManagedCname(input: {
    apiToken: string;
    zoneId: string;
    hostname: string;
    targetHostname: string;
  }) {
    const hostname = normalizeHostname(input.hostname);
    const targetHostname = normalizeHostname(input.targetHostname);
    const records = await this.listRecords(input.apiToken, input.zoneId, hostname);
    return records.some(
      (record) =>
        record.type === "CNAME" &&
        normalizeHostname(record.name) === hostname &&
        normalizeHostname(record.content) === targetHostname &&
        record.comment === CLOUDFLARE_MANAGED_RECORD_COMMENT,
    );
  }

  private async verifyDnsWrite(
    apiToken: string,
    zoneId: string,
    managedBaseDomain: string,
  ) {
    const nonce = randomUUID().replaceAll("-", "");
    const name = `_resourceportal-connect-${nonce.slice(0, 12)}.${managedBaseDomain}`;
    const record = await this.createRecord(apiToken, zoneId, {
      type: "TXT",
      name,
      content: `resourceportal-connectivity-check=${nonce}`,
      ttl: 60,
      comment: CLOUDFLARE_MANAGED_RECORD_COMMENT,
    });
    try {
      await this.deleteRecord(apiToken, zoneId, record.id);
    } catch (error) {
      throw new CloudflareApiError(
        `Cloudflare DNS write validation created its probe but could not remove it: ${safeMessage(error)}`,
      );
    }
  }

  private listRecords(apiToken: string, zoneId: string, hostname: string) {
    const query = new URLSearchParams({ name: hostname, per_page: "100" });
    return this.request<CloudflareDnsRecord[]>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?${query.toString()}`,
      apiToken,
    );
  }

  private createRecord(
    apiToken: string,
    zoneId: string,
    body: Record<string, unknown>,
  ) {
    return this.request<CloudflareDnsRecord>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      apiToken,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  private deleteRecord(apiToken: string, zoneId: string, recordId: string) {
    return this.request<{ id: string }>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      apiToken,
      { method: "DELETE" },
    );
  }

  private async request<T>(
    path: string,
    apiToken: string,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new CloudflareApiError(
        `Cloudflare API request failed: ${safeMessage(error)}`,
      );
    }

    let payload: CloudflareEnvelope<T>;
    try {
      payload = (await response.json()) as CloudflareEnvelope<T>;
    } catch {
      throw new CloudflareApiError(
        `Cloudflare API returned invalid JSON (${response.status})`,
      );
    }

    if (!response.ok || !payload.success) {
      const detail = (payload.errors ?? [])
        .map((item) => item.message)
        .filter(Boolean)
        .join("; ");
      throw new CloudflareApiError(
        detail || `Cloudflare API request failed (${response.status})`,
      );
    }
    return payload.result;
  }
}

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}
