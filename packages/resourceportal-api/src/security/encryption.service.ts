import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const PREFIX = "enc:v1";

@Injectable()
export class EncryptionService {
  constructor(private readonly config: ConfigService) {}

  encrypt(plaintext: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [PREFIX, this.encode(iv), this.encode(tag), this.encode(ciphertext)].join(
      ":",
    );
  }

  decrypt(value: string) {
    if (!value.startsWith(`${PREFIX}:`)) {
      return value;
    }

    const [, , iv, tag, ciphertext] = value.split(":");

    if (!iv || !tag || !ciphertext) {
      throw new Error("Invalid encrypted value format");
    }

    const decipher = createDecipheriv("aes-256-gcm", this.key(), this.decode(iv));
    decipher.setAuthTag(this.decode(tag));

    return Buffer.concat([
      decipher.update(this.decode(ciphertext)),
      decipher.final(),
    ]).toString("utf8");
  }

  private key() {
    const configured = this.config.get<string>("RESOURCE_ENCRYPTION_KEY");

    if (configured) {
      const decoded = Buffer.from(configured, "base64");

      if (decoded.length === 32) {
        return decoded;
      }
    }

    return createHash("sha256")
      .update(configured ?? "resource-portal-dev-encryption-key-change-me")
      .digest();
  }

  private encode(value: Buffer) {
    return value.toString("base64url");
  }

  private decode(value: string) {
    return Buffer.from(value, "base64url");
  }
}
