import { Injectable } from "@nestjs/common";
import { spawnSync } from "node:child_process";

@Injectable()
export class WireGuardKeyService {
  generateKeyPair() {
    const privateKey = this.run(["genkey"]);
    const publicKey = this.run(["pubkey"], privateKey + "\n");
    return { privateKey, publicKey };
  }

  isPublicKey(value: string) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
    try {
      return Buffer.from(value, "base64").length === 32;
    } catch {
      return false;
    }
  }

  protected run(args: string[], input?: string) {
    const result = spawnSync("wg", args, {
      encoding: "utf8",
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(
        `wg ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    }
    const value = (result.stdout ?? "").trim();
    if (!value) throw new Error(`wg ${args.join(" ")} returned no data`);
    return value;
  }
}
