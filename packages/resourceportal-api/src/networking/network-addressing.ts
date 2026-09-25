export const DEFAULT_NETWORK_POOL = "10.240.0.0/16";
export const DEFAULT_OVERLAY_POOL = "10.200.0.0/16";
export const DEFAULT_GATE_TUNNEL_POOL = "100.96.0.0/11";
export const DEFAULT_NETWORK_PREFIX = 24;
export const FIRST_APPLICATION_HOST_OFFSET = 10;

export type Ipv4Cidr = {
  normalized: string;
  network: number;
  broadcast: number;
  prefix: number;
  mask: number;
};

function ipv4ToInt(value: string): number | null {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    result = (result << 8) | value;
  }
  return result >>> 0;
}

export function intToIpv4(value: number) {
  const n = value >>> 0;
  return [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ].join(".");
}

export function parseIpv4Cidr(input: string): Ipv4Cidr | null {
  const [addressPart, prefixPart] = input.trim().split("/");
  const address = ipv4ToInt(addressPart ?? "");
  if (address === null) return null;
  const prefix =
    prefixPart === undefined || prefixPart === ""
      ? 32
      : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask =
    prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (address & mask) >>> 0;
  const hostMask = (~mask) >>> 0;
  const broadcast = (network | hostMask) >>> 0;
  return {
    normalized: `${intToIpv4(network)}/${prefix}`,
    network,
    broadcast,
    prefix,
    mask,
  };
}

export function isPrivateIpv4Cidr(cidr: Ipv4Cidr) {
  const ranges = [
    parseIpv4Cidr("10.0.0.0/8"),
    parseIpv4Cidr("172.16.0.0/12"),
    parseIpv4Cidr("192.168.0.0/16"),
  ].filter((value): value is Ipv4Cidr => Boolean(value));
  return ranges.some(
    (range) =>
      cidr.network >= range.network && cidr.broadcast <= range.broadcast,
  );
}

export function cidrsOverlap(a: Ipv4Cidr, b: Ipv4Cidr) {
  return a.network <= b.broadcast && b.network <= a.broadcast;
}

export function containsIpv4(cidr: Ipv4Cidr, address: string) {
  const value = ipv4ToInt(address);
  return value !== null && value >= cidr.network && value <= cidr.broadcast;
}

export function nextAvailableApplicationAddress(
  cidr: Ipv4Cidr,
  usedAddresses: Iterable<string>,
) {
  const used = new Set(usedAddresses);
  const first = cidr.network + FIRST_APPLICATION_HOST_OFFSET;
  const last = cidr.broadcast - 1;
  if (first > last) return null;
  for (let value = first; value <= last; value += 1) {
    const address = intToIpv4(value);
    if (!used.has(address)) return address;
  }
  return null;
}

export function candidateSubnets(
  poolInput = DEFAULT_NETWORK_POOL,
  prefix = DEFAULT_NETWORK_PREFIX,
) {
  const pool = parseIpv4Cidr(poolInput);
  if (!pool) throw new Error("Invalid network pool");
  if (prefix < pool.prefix || prefix > 30) {
    throw new Error("Invalid child network prefix");
  }
  const blockSize = 2 ** (32 - prefix);
  const values: Ipv4Cidr[] = [];
  for (
    let network = pool.network;
    network + blockSize - 1 <= pool.broadcast;
    network += blockSize
  ) {
    const cidr = parseIpv4Cidr(`${intToIpv4(network)}/${prefix}`);
    if (cidr) values.push(cidr);
  }
  return values;
}

export function nextAvailableGateTunnel(
  usedAddresses: Iterable<string>,
  poolInput = DEFAULT_GATE_TUNNEL_POOL,
) {
  const pool = parseIpv4Cidr(poolInput);
  if (!pool || pool.prefix > 30) {
    throw new Error("Invalid Gate tunnel pool");
  }
  const used = [...usedAddresses]
    .map((value) => value.split("/")[0]?.trim())
    .filter((value): value is string => Boolean(value));
  const usedSet = new Set(used);
  const blockSize = 4;
  for (
    let network = pool.network;
    network + blockSize - 1 <= pool.broadcast;
    network += blockSize
  ) {
    const server = intToIpv4(network + 1);
    const client = intToIpv4(network + 2);
    if (!usedSet.has(server) && !usedSet.has(client)) {
      return {
        cidr: `${intToIpv4(network)}/30`,
        server: `${server}/30`,
        client: `${client}/30`,
      };
    }
  }
  return null;
}

export function nextAvailableNetworkCidr(
  existingCidrs: Iterable<string>,
  poolInput = DEFAULT_NETWORK_POOL,
  prefix = DEFAULT_NETWORK_PREFIX,
) {
  const existing = [...existingCidrs]
    .map(parseIpv4Cidr)
    .filter((value): value is Ipv4Cidr => Boolean(value));
  for (const candidate of candidateSubnets(poolInput, prefix)) {
    if (!existing.some((item) => cidrsOverlap(item, candidate))) {
      return candidate.normalized;
    }
  }
  return null;
}
