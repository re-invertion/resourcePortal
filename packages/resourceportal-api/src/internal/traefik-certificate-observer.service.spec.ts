import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());

vi.mock("node:tls", () => ({
  connect: connectMock,
}));

import { TraefikCertificateObserverService } from "./traefik-certificate-observer.service";

function socketWithCertificate(certificate: Record<string, unknown>) {
  const socket = new EventEmitter() as EventEmitter & {
    authorized: boolean;
    authorizationError?: Error;
    getPeerCertificate: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  socket.authorized = true;
  socket.getPeerCertificate = vi.fn(() => certificate);
  socket.setTimeout = vi.fn();
  socket.destroy = vi.fn();
  return socket;
}

function service(timeout = "5000") {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) =>
      key === "TRAEFIK_TLS_OBSERVE_TIMEOUT_MS" ? timeout : fallback,
    ),
  };
  return new TraefikCertificateObserverService(
    config as unknown as ConfigService,
  );
}

describe("TraefikCertificateObserverService", () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it("returns only safe public certificate metadata from a TLS handshake", async () => {
    const socket = socketWithCertificate({
      subjectaltname: "DNS:app.example.com, DNS:www.example.com",
      valid_to: "Nov 30 12:00:00 2026 GMT",
      issuer: { CN: "R12", O: "Let's Encrypt" },
      raw: Buffer.from("public-certificate"),
    });
    connectMock.mockImplementation((_options, callback: () => void) => {
      queueMicrotask(callback);
      return socket;
    });

    const result = await service().observe("app.example.com");

    expect(connectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "app.example.com",
        port: 443,
        servername: "app.example.com",
        rejectUnauthorized: false,
      }),
      expect.any(Function),
    );
    expect(result).toEqual({
      hostname: "app.example.com",
      domains: ["app.example.com", "www.example.com"],
      expiresAt: new Date("2026-11-30T12:00:00.000Z"),
      issuer: "R12",
    });
    expect(result).not.toHaveProperty("privateKey");
    expect(result).not.toHaveProperty("raw");
  });

  it("returns an observation error when the TLS connection fails", async () => {
    const socket = socketWithCertificate({});
    connectMock.mockImplementation(() => {
      queueMicrotask(() => socket.emit("error", new Error("ECONNREFUSED")));
      return socket;
    });

    await expect(service().observe("app.example.com")).rejects.toThrow(
      "ECONNREFUSED",
    );
    expect(socket.destroy).toHaveBeenCalled();
  });
});
