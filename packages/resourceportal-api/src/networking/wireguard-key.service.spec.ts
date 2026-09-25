import { describe, expect, it } from "vitest";
import { WireGuardKeyService } from "./wireguard-key.service";

class TestKeyService extends WireGuardKeyService {
  private readonly values = [
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
  ];
  protected override run() {
    return this.values.shift() ?? "";
  }
}

describe("WireGuardKeyService", () => {
  it("returns a private/public pair without persisting plaintext", () => {
    expect(new TestKeyService().generateKeyPair()).toEqual({
      privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    });
  });

  it("accepts only 32-byte WireGuard public keys", () => {
    const service = new WireGuardKeyService();
    expect(
      service.isPublicKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    ).toBe(true);
    expect(service.isPublicKey("not-a-key")).toBe(false);
  });
});
