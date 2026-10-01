import net from "node:net";
import os from "node:os";

import { config } from "./config.js";

/**
 * Which address a published port is reachable at, and which one it must never be.
 *
 * A container has several addresses and only one of them is useful to anybody
 * outside it. The docker bridge (`172.17.0.0/16` and the rest of docker's
 * default pools) is reachable from the containers on that bridge and from
 * nowhere else; loopback is reachable from this process and nowhere else. An
 * address that only the local host can dial is worse than no address at all,
 * because a URL that looks like a URL gets pasted into a gateway that then fails
 * to connect — which is how a bug in the shape of a URL becomes a bug report
 * about the gateway.
 *
 * So this module answers one question — "what is this deployment's LAN address?"
 * — with the platform's own convention (`stack_lib_lan_ip` in the stack repo):
 * a private address on the default route, never loopback, never a docker bridge.
 * The platform states the rule directly, and it is the rule here too: a
 * docker-bridge or loopback address is never used as an upstream.
 *
 * There are two ways to get the answer, in order:
 *
 *  1. **Told.** `AGENT_LAN_IP` wins, and it is the one to use in a container:
 *     from inside a docker container the only addresses this process can see are
 *     its own bridge addresses — the exact thing this is here to avoid. The
 *     deployment knows the address (the incus container's `192.168.1.21`), so the
 *     deployment names it. An operator naming an address has already answered the
 *     question, so it is returned as given.
 *  2. **Detected.** With nothing configured, the private addresses this host
 *     actually holds, `192.168.*` and `10.*` before anything else. Deliberately
 *     not a routing-table probe: this is synchronous and testable, and the case
 *     it cannot see — a container whose routable address belongs to its host —
 *     is precisely the case configuration exists for.
 */

/** Docker's default bridge pools are all inside 172.16.0.0/12. */
function isPrivate172(ip: string): boolean {
  return /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip);
}

/** Link-local, including the 169.254.169.254 address clouds hand out. */
function isLinkLocal(ip: string): boolean {
  return ip.startsWith("169.254.");
}

/**
 * Addresses worth publishing behind. Not a security check: just "is this a
 * number somebody else on the network could plausibly type".
 */
export function isPublishable(ip: string): boolean {
  if (ip === "" || ip.startsWith("127.") || isLinkLocal(ip)) return false;
  if (!net.isIPv4(ip)) return false;
  return !isPrivate172(ip);
}

/** Private IPv4 addresses this host holds, the ones another host could reach. */
export function interfaceAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4") continue;
      if (!isPublishable(entry.address)) continue;
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

/** The address a LAN service would use, or null when there is nothing to name. */
export function detectLanAddress(): string | null {
  // The ranges a home or office LAN uses come first; 172.* is where docker
  // lives, so it is the last candidate rather than the first.
  const candidates = interfaceAddresses();
  const preferred = candidates.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10."));
  return preferred ?? candidates[0] ?? null;
}

/**
 * This deployment's LAN address, or null when it has none worth naming.
 *
 * Exported as a function rather than a constant so a test can ask the question
 * with a different answer configured, without reaching into module state.
 */
export function lanAddress(): string | null {
  const named = config.lanIp.trim();
  if (named !== "") return named;
  return detectLanAddress();
}

/**
 * The URL a published port lives at, or null when nothing publishable is known.
 *
 * A bare IPv6 address needs brackets; IPv4 and a hostname do not, which is the
 * whole of the difference worth handling here.
 */
export function addressFor(host: string | null, port: number | null): string | null {
  if (host === null || host === "" || port === null) return null;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${port}/`;
}
