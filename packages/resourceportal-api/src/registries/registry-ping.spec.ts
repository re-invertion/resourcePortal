import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { isAllowedRegistryAddress, pingRegistry, replyWithPinnedRegistryAddress, resolveRegistryDestination } from "./registry-ping";

describe("registry ping SSRF boundary (#207)", () => {
  it.each([
    "127.0.0.1", "10.0.1.10", "172.16.1.1", "192.168.100.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.1",
    "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1",
    "64:ff9b::a9fe:a9fe", "2002:0a00:0001::1",
  ])("refuses non-public address %s before making a network request", async (address) => {
    expect(isAllowedRegistryAddress(address)).toBe(false);
    const hostname = address.includes(":") ? `[${address}]` : address;
    await expect(resolveRegistryDestination(new URL(`https://${hostname}/v2/`)))
      .rejects.toThrow(/non-public address/);
  });

  it("allows public addresses and pins the selected DNS answer", async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: "1.1.1.1", family: 4 }, { address: "2606:4700:4700::1111", family: 6 },
    ]);
    await expect(resolveRegistryDestination(new URL("https://registry.example.com/v2/"), resolver))
      .resolves.toEqual({ address: "1.1.1.1", family: 4 });
    expect(resolver).toHaveBeenCalledExactlyOnceWith("registry.example.com");
  });

  it("rejects DNS responses containing even one internal address (no fallback to a public IP)", async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: "1.1.1.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(resolveRegistryDestination(new URL("https://registry.example.com/v2/"), resolver))
      .rejects.toThrow(/non-public address/);
  });

  it.each([
    "https://example.com:22/v2/", "ftp://example.com/v2/",
    "https://user:pass@example.com/v2/", "https://example.com/v2/?next=localhost",
  ])("rejects unexpected schemes, ports and URL components: %s", async (url) => {
    const resolver = vi.fn().mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    await expect(resolveRegistryDestination(new URL(url), resolver))
      .rejects.toThrow(/not permitted/);
    expect(resolver).not.toHaveBeenCalled();
  });
});


describe("actual registry HTTP entrypoint", () => {
  it("rejects metadata service IP without transmitting authorization", async () => {
    await expect(pingRegistry("http://169.254.169.254/v2/", {
      authorization: "Bearer must-not-leave-process",
    })).rejects.toThrow(/non-public address/);
  });
});


describe("Node address-family selection (#362, #366)", () => {
  it.each([true, false])("passes a vetted address through the real Node HTTP socket (all=%s)", async (all) => {
    // A public address is required by the production SSRF policy. Abort at
    // lookup completion, before Node can open an external connection.
    const selected = { address: "1.1.1.1", family: 4 as const };
    const controller = new AbortController();
    const result = await new Promise<string>((resolve) => {
      const req = httpRequest("http://registry.example.test/v2/", {
        agent: false, autoSelectFamily: all, signal: controller.signal,
        lookup: (_host, options, callback) => {
          replyWithPinnedRegistryAddress(selected, typeof options === "object" && options.all === true, callback);
          controller.abort();
        },
      });
      req.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
      req.end();
    });
    expect(result).toBe("ABORT_ERR");
  });
});
