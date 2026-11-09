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
      key === "TRAEFIK_TLS_OBSERVE_TIMEOUT_MS" ? timeout :
      key === "INSTALLER_SWARM_ADVERTISE_ADDR" ? "10.0.0.10" : fallback,
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

  it("returns only safe public certificate metadata from a trusted TLS handshake", async () => {
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
        host: "10.0.0.10",
        port: 443,
        servername: "app.example.com",
        rejectUnauthorized: true,
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

  it("never falls back to public DNS when the managed ingress address is missing", async () => {
    const noIngress = new TraefikCertificateObserverService({
      get: vi.fn(() => undefined),
    } as unknown as ConfigService);
    await expect(noIngress.observe("app.example.com")).rejects.toThrow("ManagedIngressAddressUnavailable");
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("does not fabricate hostname coverage when peer SAN is absent", async () => {
    const socket = socketWithCertificate({
      valid_to: "Nov 30 12:00:00 2026 GMT",
      issuer: { CN: "R12" },
    });
    connectMock.mockImplementation((_options, callback: () => void) => {
      queueMicrotask(callback);
      return socket;
    });
    const result = await service().observe("app.example.com");
    expect(result.domains).toEqual([]);
  });

  it("times out and destroys the socket for an unresponsive ingress", async () => {
    const socket = socketWithCertificate({});
    let onTimeout: (() => void) | undefined;
    socket.setTimeout.mockImplementation((_ms: number, callback: () => void) => {
      onTimeout = callback;
    });
    connectMock.mockReturnValue(socket);
    const request = service("100").observe("app.example.com");
    expect(socket.setTimeout).toHaveBeenCalledWith(100, expect.any(Function));
    onTimeout?.();
    await expect(request).rejects.toThrow("timed out");
    expect(socket.destroy).toHaveBeenCalled();
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
