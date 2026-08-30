import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { EncryptionService } from "./encryption.service";

type SecretEnvelope = {
  version: 1;
  algorithm: "AES-256-GCM";
  keyVersion: 1;
  encryptedDataKey: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
};

@Injectable()
export class SecretStorageService {
  constructor(
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
  ) {}

  path(tenantId: string, appGroupId: string, secretName: string) {
    this.assertSafeSegment(secretName);
    const root = this.config.get<string>(
      "RESOURCE_SECRET_STORAGE_ROOT",
      "/rp/secrets",
    );

    return join(root, tenantId, appGroupId, secretName);
  }

  async read(storagePath: string) {
    const envelope = JSON.parse(
      await readFile(storagePath, "utf8"),
    ) as SecretEnvelope;

    if (
      envelope.version !== 1 ||
      envelope.algorithm !== "AES-256-GCM" ||
      typeof envelope.encryptedDataKey !== "string" ||
      typeof envelope.nonce !== "string" ||
      typeof envelope.ciphertext !== "string" ||
      typeof envelope.authTag !== "string"
    ) {
      throw new Error("Invalid encrypted Secret envelope");
    }

    const dataKey = Buffer.from(
      this.encryption.decrypt(envelope.encryptedDataKey),
      "base64url",
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      dataKey,
      Buffer.from(envelope.nonce, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
  }

  async replaceAtomically<T>(
    storagePath: string,
    plaintext: Buffer,
    persist: () => Promise<T>,
  ) {
    const directory = dirname(storagePath);
    const fileName = basename(storagePath);
    const temporaryPath = join(directory, `.${fileName}.${randomUUID()}.tmp`);
    const backupPath = join(directory, `.${fileName}.${randomUUID()}.bak`);
    let backupCreated = false;
    let replacementApplied = false;
    let persisted = false;

    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, JSON.stringify(this.encrypt(plaintext)), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    try {
      try {
        await rename(storagePath, backupPath);
        backupCreated = true;
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }

      await rename(temporaryPath, storagePath);
      replacementApplied = true;
      const result = await persist();
      persisted = true;

      if (backupCreated) {
        await unlinkIgnoringErrors(backupPath);
      }

      return result;
    } catch (error) {
      if (persisted) {
        throw error;
      }

      if (replacementApplied) {
        await unlinkIgnoringMissing(storagePath);
      } else {
        await unlinkIgnoringMissing(temporaryPath);
      }

      if (backupCreated) {
        await rename(backupPath, storagePath);
      }

      throw error;
    }
  }

  async deleteAtomically<T>(storagePath: string, persist: () => Promise<T>) {
    const trashPath = `${storagePath}.${randomUUID()}.deleted`;
    let moved = false;
    let persisted = false;

    try {
      try {
        await rename(storagePath, trashPath);
        moved = true;
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }

      const result = await persist();
      persisted = true;
      if (moved) {
        await unlinkIgnoringErrors(trashPath);
      }
      return result;
    } catch (error) {
      if (persisted) {
        throw error;
      }

      if (moved) {
        await rename(trashPath, storagePath);
      }
      throw error;
    }
  }

  async deleteBestEffort(storagePath: string) {
    await unlinkIgnoringErrors(storagePath);
  }

  private encrypt(plaintext: Buffer): SecretEnvelope {
    const dataKey = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      version: 1,
      algorithm: "AES-256-GCM",
      keyVersion: 1,
      encryptedDataKey: this.encryption.encrypt(dataKey.toString("base64url")),
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
  }

  private assertSafeSegment(value: string) {
    if (
      basename(value) !== value ||
      value === "." ||
      value.includes("..") ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(value)
    ) {
      throw new Error("Invalid Secret storage name");
    }
  }
}

function isMissingFile(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function unlinkIgnoringMissing(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

async function unlinkIgnoringErrors(path: string) {
  try {
    await unlink(path);
  } catch {
    // The database and active file already contain the committed state.
    // A stale backup/trash file is safer than rolling back only the filesystem.
  }
}
