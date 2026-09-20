import { isIP } from "node:net";

export type ParsedCidr = {
  address: string;
  prefix: number;
  version: 4 | 6;
  normalized: string;
};

export function parseAndNormalizeCidr(input: string): ParsedCidr | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  const address = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefixRaw = slash === -1 ? undefined : trimmed.slice(slash + 1);
  const version = isIP(address);
  if (version !== 4 && version !== 6) return null;
  const maxPrefix = version === 4 ? 32 : 128;
  const prefix = prefixRaw === undefined ? maxPrefix : Number.parseInt(prefixRaw, 10);
  if (
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > maxPrefix ||
    (prefixRaw !== undefined && String(prefix) !== prefixRaw)
  ) {
    return null;
  }

  if (version === 4) {
    const parts = address.split(".").map((part) => Number.parseInt(part, 10));
    const value =
      (((parts[0] ?? 0) << 24) >>> 0) |
      ((parts[1] ?? 0) << 16) |
      ((parts[2] ?? 0) << 8) |
      (parts[3] ?? 0);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = value & mask;
    const normalizedAddress = [
      (network >>> 24) & 0xff,
      (network >>> 16) & 0xff,
      (network >>> 8) & 0xff,
      network & 0xff,
    ].join(".");
    return {
      address: normalizedAddress,
      prefix,
      version: 4,
      normalized: `${normalizedAddress}/${prefix}`,
    };
  }

  const normalizedAddress = address.toLowerCase();
  return {
    address: normalizedAddress,
    prefix,
    version: 6,
    normalized: `${normalizedAddress}/${prefix}`,
  };
}
