/**
 * Produce one iptables-restore input for the filter and NAT tables.
 * Unlike repeated iptables -F/-A calls, each table changes at COMMIT without
 * exposing an empty forwarding chain to traffic between commands.
 */
export function atomicVpnFirewallRestore(input: {
  forwardChain: string;
  dnatChain: string;
  snatChain: string;
  forward: string[][];
  dnat: string[][];
  snat: string[][];
}) {
  const chains = [input.forwardChain, input.dnatChain, input.snatChain];
  if (chains.some((name) => !/^[A-Z0-9-]+$/.test(name))) {
    throw new Error("Invalid VPN firewall chain name");
  }
  const render = (rules: string[][], chain: string) =>
    rules.map((args) => {
      if (args.length < 3 || args[0] !== "-A" || args[1] !== chain ||
          args.some((arg) => !/^[A-Za-z0-9_./,:=!%-]+$/.test(arg))) {
        throw new Error("Invalid VPN firewall rule token");
      }
      return args.join(" ");
    });
  return [
    "*filter",
    `-F ${input.forwardChain}`,
    ...render(input.forward, input.forwardChain),
    "COMMIT",
    "*nat",
    `-F ${input.dnatChain}`,
    `-F ${input.snatChain}`,
    ...render(input.dnat, input.dnatChain),
    ...render(input.snat, input.snatChain),
    "COMMIT",
    "",
  ].join("\n");
}
