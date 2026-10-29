import { BlockList, isIP } from "node:net";

/*
 * IP allowlists: single IPs (`58.65.176.229`) or CIDR ranges
 * (`2407:d000:1c:2553::/64`), IPv4 or IPv6. Kept free of app imports so the
 * env schema can validate a list at boot without an import cycle.
 */

/** Express reports IPv4 clients on a dual-stack socket as `::ffff:1.2.3.4`. */
export function normalise(ip: string): string {
  return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/** Parses each entry; throws on one that is neither an address nor a CIDR range. */
export function buildAllowlist(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix] = entry.split("/");
    const version = isIP(address);
    if (version === 0) throw new Error(`Not an IP address or CIDR range: ${entry}`);
    const type = version === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const bits = Number(prefix);
    if (!/^\d{1,3}$/.test(prefix) || bits > (version === 4 ? 32 : 128)) {
      throw new Error(`Not an IP address or CIDR range: ${entry}`);
    }
    list.addSubnet(address, bits, type);
  }
  return list;
}
