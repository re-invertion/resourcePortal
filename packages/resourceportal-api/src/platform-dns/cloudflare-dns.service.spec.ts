import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareDnsRecordConflictError,
  CloudflareDnsService,
} from "./cloudflare-dns.service";
import { CLOUDFLARE_MANAGED_RECORD_COMMENT } from "./platform-dns.constants";

function response(result: unknown, status = 200) {
  return new Response(
    JSON.stringify({
      success: status >= 200 && status < 300,
      result,
      errors: [],
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

function requestUrl(input: unknown) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (
    typeof input === "object" &&
    input !== null &&
    "url" in input &&
    typeof input.url === "string"
  ) {
    return input.url;
  }
  throw new TypeError("Unexpected fetch input");
}

function jsonBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected JSON string request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe("CloudflareDnsService", () => {
  it("validates token, zone and DNS write/delete access before accepting the connection", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = requestUrl(input);
        calls.push({ url, init });
        if (url.endsWith("/user/tokens/verify")) {
          return Promise.resolve(response({ id: "token-1", status: "active" }));
        }
        if (url.endsWith("/zones/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")) {
          return Promise.resolve(
            response({
              id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              name: "resource-portal.pl",
              status: "active",
            }),
          );
        }
        if (url.endsWith("/dns_records") && init?.method === "POST") {
          return Promise.resolve(
            response({
              id: "probe-1",
              type: "TXT",
              name: "probe",
              content: "probe",
            }),
          );
        }
        if (url.endsWith("/dns_records/probe-1") && init?.method === "DELETE") {
          return Promise.resolve(response({ id: "probe-1" }));
        }
        return Promise.reject(
          new Error(`Unexpected ${init?.method ?? "GET"} ${url}`),
        );
      }),
    );

    const service = new CloudflareDnsService();
    await expect(
      service.validateConnection({
        apiToken: "secret-token",
        zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        managedBaseDomain: "apps.resource-portal.pl",
      }),
    ).resolves.toEqual({
      zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      zoneName: "resource-portal.pl",
    });

    const probe = calls.find(
      (call) =>
        call.url.endsWith("/dns_records") && call.init?.method === "POST",
    );
    expect(jsonBody(probe?.init)).toMatchObject({
      type: "TXT",
      ttl: 60,
      comment: CLOUDFLARE_MANAGED_RECORD_COMMENT,
    });
    expect(
      calls.some(
        (call) =>
          call.url.endsWith("/dns_records/probe-1") &&
          call.init?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("creates a DNS-only CNAME for a new ResourcePortal managed hostname", async () => {
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = requestUrl(input);
      if (
        url.includes("/dns_records?") &&
        (!init?.method || init.method === "GET")
      ) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith("/dns_records") && init?.method === "POST") {
        return Promise.resolve(response({ id: "record-1", ...jsonBody(init) }));
      }
      return Promise.reject(
        new Error(`Unexpected ${init?.method ?? "GET"} ${url}`),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new CloudflareDnsService();

    await expect(
      service.ensureManagedCname({
        apiToken: "secret-token",
        zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        hostname: "penpot.resource-portal.pl",
        targetHostname: "resource-portal.pl",
      }),
    ).resolves.toMatchObject({
      created: true,
      record: { id: "record-1" },
    });

    const create = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(jsonBody(create?.[1])).toEqual({
      type: "CNAME",
      name: "penpot.resource-portal.pl",
      content: "resource-portal.pl",
      ttl: 1,
      proxied: false,
      comment: CLOUDFLARE_MANAGED_RECORD_COMMENT,
    });
  });

  it("is idempotent only for the exact record owned by ResourcePortal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response([
            {
              id: "record-1",
              type: "CNAME",
              name: "penpot.resource-portal.pl",
              content: "resource-portal.pl",
              comment: CLOUDFLARE_MANAGED_RECORD_COMMENT,
            },
          ]),
        ),
      ),
    );
    const service = new CloudflareDnsService();
    await expect(
      service.ensureManagedCname({
        apiToken: "secret-token",
        zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        hostname: "penpot.resource-portal.pl",
        targetHostname: "resource-portal.pl",
      }),
    ).resolves.toMatchObject({
      created: false,
      record: { id: "record-1" },
    });
  });

  it("adopts an exact legacy CNAME that has no ownership comment", async () => {
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = requestUrl(input);
      if (
        url.includes("/dns_records?") &&
        (!init?.method || init.method === "GET")
      ) {
        return Promise.resolve(
          response([
            {
              id: "legacy-1",
              type: "CNAME",
              name: "penpot.resource-portal.pl",
              content: "resource-portal.pl",
              comment: null,
            },
          ]),
        );
      }
      if (url.endsWith("/dns_records/legacy-1") && init?.method === "PATCH") {
        return Promise.resolve(
          response({
            id: "legacy-1",
            type: "CNAME",
            name: "penpot.resource-portal.pl",
            content: "resource-portal.pl",
            comment: jsonBody(init).comment,
          }),
        );
      }
      return Promise.reject(
        new Error(`Unexpected ${init?.method ?? "GET"} ${url}`),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new CloudflareDnsService();

    await expect(
      service.ensureManagedCname({
        apiToken: "secret-token",
        zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        hostname: "penpot.resource-portal.pl",
        targetHostname: "resource-portal.pl",
      }),
    ).resolves.toMatchObject({
      created: false,
      adopted: true,
      record: { id: "legacy-1", comment: CLOUDFLARE_MANAGED_RECORD_COMMENT },
    });

    const patch = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(jsonBody(patch?.[1])).toEqual({
      comment: CLOUDFLARE_MANAGED_RECORD_COMMENT,
    });
  });

  it("adopts an exact legacy CNAME while checking managed-domain existence", async () => {
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = requestUrl(input);
      if (
        url.includes("/dns_records?") &&
        (!init?.method || init.method === "GET")
      ) {
        return Promise.resolve(
          response([
            {
              id: "legacy-1",
              type: "CNAME",
              name: "penpot.resource-portal.pl",
              content: "resource-portal.pl",
            },
          ]),
        );
      }
      if (url.endsWith("/dns_records/legacy-1") && init?.method === "PATCH") {
        return Promise.resolve(
          response({
            id: "legacy-1",
            type: "CNAME",
            name: "penpot.resource-portal.pl",
            content: "resource-portal.pl",
            comment: CLOUDFLARE_MANAGED_RECORD_COMMENT,
          }),
        );
      }
      return Promise.reject(
        new Error(`Unexpected ${init?.method ?? "GET"} ${url}`),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new CloudflareDnsService();

    await expect(
      service.hasManagedCname({
        apiToken: "secret-token",
        zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        hostname: "penpot.resource-portal.pl",
        targetHostname: "resource-portal.pl",
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not adopt an exact CNAME that carries a foreign ownership comment", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        response([
          {
            id: "foreign-cname",
            type: "CNAME",
            name: "penpot.resource-portal.pl",
            content: "resource-portal.pl",
            comment: "Managed externally",
          },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new CloudflareDnsService();

    await expect(
      service.ensureManagedCname({
        apiToken: "secret-token",
        zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        hostname: "penpot.resource-portal.pl",
        targetHostname: "resource-portal.pl",
      }),
    ).rejects.toBeInstanceOf(CloudflareDnsRecordConflictError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to overwrite an unmanaged record with the requested hostname", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response([
            {
              id: "foreign-1",
              type: "A",
              name: "penpot.resource-portal.pl",
              content: "203.0.113.5",
            },
          ]),
        ),
      ),
    );
    const service = new CloudflareDnsService();
    try {
      await service.ensureManagedCname({
        apiToken: "secret-token",
        zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        hostname: "penpot.resource-portal.pl",
        targetHostname: "resource-portal.pl",
      });
      throw new Error("Expected a DNS record conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareDnsRecordConflictError);
      expect(error).toMatchObject({
        hostname: "penpot.resource-portal.pl",
        category: "configuration",
        records: [{ type: "A", content: "203.0.113.5" }],
      });
      expect((error as Error).message).toContain(
        "Remove or rename the existing record in Cloudflare",
      );
    }
  });

  it("creates the exact custom-domain verification TXT inside the authorized zone", async () => {
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/zones/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")) {
        return Promise.resolve(
          response({
            id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            name: "example.com",
            status: "active",
          }),
        );
      }
      if (
        url.includes("/dns_records?") &&
        (!init?.method || init.method === "GET")
      ) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith("/dns_records") && init?.method === "POST") {
        return Promise.resolve(response({ id: "txt-1", ...jsonBody(init) }));
      }
      return Promise.reject(
        new Error(`Unexpected ${init?.method ?? "GET"} ${url}`),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new CloudflareDnsService();

    await expect(
      service.ensureVerificationTxt({
        apiToken: "oauth-token",
        zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rootDomain: "apps.example.com",
        content: "rp-domain-verification=abc123",
      }),
    ).resolves.toMatchObject({
      created: true,
      zone: { name: "example.com" },
      record: { id: "txt-1" },
    });

    const create = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(jsonBody(create?.[1])).toEqual({
      type: "TXT",
      name: "apps.example.com",
      content: "rp-domain-verification=abc123",
      ttl: 300,
      comment: "Managed by ResourcePortal custom-domain verification",
    });
  });
});
