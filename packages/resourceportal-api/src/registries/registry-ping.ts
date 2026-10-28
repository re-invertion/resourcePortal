import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

type Address = { address: string; family: 4 | 6 };
type Resolver = (hostname: string) => Promise<Address[]>;

// Registry verification is a privileged server-side network request. Never
// connect to loopback, private, link-local, multicast or reserved destinations.
// Deny IP-embedding mechanisms such as 6to4/NAT64 as well.
// Keep family lists separate: Node BlockList normalizes IPv4 inputs as
// IPv4-mapped IPv6 and an ::ffff/96 deny would otherwise block ALL IPv4.
const forbiddenIpv4 = new BlockList();
const forbiddenIpv6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) forbiddenIpv4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96], ["::1", 128], ["::ffff:0:0", 96],
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8],
] as const) forbiddenIpv6.addSubnet(address, prefix, "ipv6");

export function isAllowedRegistryAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !forbiddenIpv4.check(address, "ipv4")
    : family === 6 && !forbiddenIpv6.check(address, "ipv6");
}

async function defaultResolver(host: string): Promise<Address[]> {
  const results = await lookup(host, { all: true });
  return results.map((item) => ({ address: item.address, family: item.family as 4 | 6 }));
}

export async function resolveRegistryDestination(
  url: URL,
  resolver: Resolver = defaultResolver,
): Promise<Address> {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (
    !["http:", "https:"].includes(url.protocol) ||
    ![80, 443, 5000, 5443, 8443].includes(port) ||
    url.username || url.password || url.search || url.hash
  ) throw new Error("Registry validation destination is not permitted");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses: Address[] = family
      ? [{ address: host, family: family as 4 | 6 }]
      : await Promise.race([
          resolver(host),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Registry DNS resolution timed out")), 5000);
          }),
        ]);

    if (!addresses.length || addresses.some(({ address }) => !isAllowedRegistryAddress(address))) {
      throw new Error("Registry validation destination resolves to a non-public address");
    }
    // Pin the HTTP connection to the vetted address, closing DNS rebinding races.
    return addresses[0];
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type PinnedLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | Address[],
  family?: 4 | 6,
) => void;

/**
 * Node's address-family autoselection uses dns.lookup({ all: true }).
 * In that mode the lookup callback must receive an array, not (address, family).
 * Returning a bare string causes "Invalid IP address: undefined" on Node 20+.
 * Both modes use the previously checked, pinned address to avoid DNS rebinding.
 */
export function replyWithPinnedRegistryAddress(
  selected: Address,
  all: boolean,
  callback: PinnedLookupCallback,
): void {
  if (all) {
    callback(null, [selected]);
  } else {
    callback(null, selected.address, selected.family);
  }
}

export async function pingRegistry(urlValue: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(urlValue);
  const selected = await resolveRegistryDestination(url);
  const makeRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<number>((resolve, reject) => {
    const request = makeRequest(url, {
      method: "GET",
      headers,
      agent: false,
      // Hostname, Host header and TLS SNI remain the original requested host.
      // Only the socket address is replaced with the previously vetted IP.
      lookup: (_hostname, options, callback) =>
        replyWithPinnedRegistryAddress(
          selected,
          typeof options === "object" && options.all === true,
          callback as unknown as PinnedLookupCallback,
        ),
      signal: AbortSignal.timeout(10_000),
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy(); // Need headers only. Never follow 3xx redirects.
      resolve(status);
    });
    request.on("error", reject);
    request.end();
  });
}
