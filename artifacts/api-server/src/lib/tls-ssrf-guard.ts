import dns from "node:dns/promises";
import { isIP } from "node:net";
import { logger } from "./logger";

/**
 * SSRF guard for B3, the TLS/cipher-suite prober — docs/Claude/03-features.md
 * §B3, `POST /api/projects/:id/tls`.
 *
 * This route does something no other route in this codebase does: it makes
 * the server open a raw socket to a host and port **a client names**. Every
 * other outbound call here is either a fixed host (`github-url.ts`'s
 * `ALLOWED_FETCH_HOSTS`) or has no network egress at all. `github-url.ts`'s
 * own writeup found that its reachable surface was *not* actually SSRF — the
 * host was always `api.github.com`/`raw.githubusercontent.com` and only the
 * path was attacker-influenced. Here the host **is** the attacker-influenced
 * value, on purpose (that is the whole feature), so this is the real thing:
 * without a guard, `POST /api/projects/1/tls` with `{"host":"169.254.169.254",
 * "port":80}` would make this server originate a TCP connection to the cloud
 * metadata service, or to `10.0.0.0/8`, from wherever it is deployed.
 *
 * ## Resolve-then-pin, not check-then-connect
 *
 * The naive fix — validate the hostname, then `tls.connect({ host: hostname
 * })` — is a TOCTOU bug: `tls.connect` re-resolves the hostname itself, and
 * nothing stops the second lookup (moments later, at connect time) from
 * returning a different, private address than the one this guard checked.
 * That is DNS rebinding, and it defeats a hostname-string check completely.
 *
 * The fix is to resolve **once**, validate the literal address that
 * resolution returned, and hand `tls.connect` that literal IP — never the
 * hostname — while still passing the original hostname as `servername` for
 * SNI and certificate-name evaluation. `resolveAndValidateTarget` below is
 * the single function that does this; `tls-probe.ts` must call it and use
 * only its returned `address`, never re-resolve the caller's `host` itself.
 *
 * ## What is blocked
 *
 * Loopback, RFC 1918 / ULA private ranges, link-local (which is where the AWS/
 * GCP/Azure metadata service at `169.254.169.254` lives), multicast,
 * "this network" (`0.0.0.0/8`), the IPv6 unspecified and documentation
 * ranges, and IPv4-mapped/NAT64 IPv6 addresses that encode a blocked IPv4
 * address. See {@link BLOCKED_IPV4_RANGES} and {@link BLOCKED_IPV6_RANGES} for
 * the exact list and citations.
 *
 * ## The test-only escape hatch
 *
 * `QUANTAXSCAN_TLS_PROBE_ALLOW_PRIVATE_TARGETS=1` disables the range check
 * (resolve-then-pin still applies — this only widens *which* addresses are
 * accepted, it does not reintroduce the rebinding gap). It exists because the
 * e2e suite's whole point is a genuine handshake against a real socket
 * (`tests/e2e/05-tls.spec.ts` starts a real `node:tls` server on loopback),
 * and loopback is exactly what production must refuse. It is **not** gated on
 * `NODE_ENV`: the e2e harness deliberately runs the API server with
 * `NODE_ENV=production` (`tests/e2e/global-setup.ts`) so the rest of the
 * suite exercises real production behaviour, and gating on that would make
 * this feature untestable in the one harness that proves it works. The
 * control that matters is that the variable has **no default** — an operator
 * has to set it explicitly, and nothing in this codebase's shipped
 * configuration (`Dockerfile.api`, `docker-compose.yml`, the README's example
 * env) sets it. A boot-time `logger.warn` (below) means a deployment that set
 * it by accident finds out from the log, not from an incident.
 */

const ESCAPE_HATCH_ENV_VAR = "QUANTAXSCAN_TLS_PROBE_ALLOW_PRIVATE_TARGETS";

function escapeHatchEnabled(): boolean {
  return process.env[ESCAPE_HATCH_ENV_VAR] === "1";
}

if (escapeHatchEnabled()) {
  logger.warn(
    { envVar: ESCAPE_HATCH_ENV_VAR },
    "TLS prober SSRF range check is DISABLED — this server will connect to loopback/private/link-local targets a caller names. " +
      "This must never be set in a production deployment.",
  );
}

interface Cidr4 {
  base: number;
  bits: number;
  note: string;
}

interface Cidr6 {
  base: bigint;
  bits: number;
  note: string;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function cidr4(cidr: string, note: string): Cidr4 {
  const [addr, bitsRaw] = cidr.split("/");
  return { base: ipv4ToInt(addr), bits: Number(bitsRaw), note };
}

function matches4(ip: number, range: Cidr4): boolean {
  if (range.bits === 0) return true;
  const mask = range.bits === 32 ? 0xffffffff : (0xffffffff << (32 - range.bits)) >>> 0;
  return (ip & mask) === (range.base & mask);
}

/**
 * IANA special-purpose IPv4 registry, the subset relevant to "must not be
 * reachable from a server that will accept a caller-named host" — private
 * (RFC 1918), loopback, link-local (RFC 3927 — the metadata-service range),
 * shared/CGNAT (RFC 6598), the documentation/benchmark ranges, multicast and
 * reserved. [Source: IANA IPv4 Special-Purpose Address Registry,
 * https://www.iana.org/assignments/iana-ipv4-special-registry/ — `verified`]
 */
const BLOCKED_IPV4_RANGES: Cidr4[] = [
  cidr4("0.0.0.0/8", "this network"),
  cidr4("10.0.0.0/8", "private (RFC 1918)"),
  cidr4("100.64.0.0/10", "shared address space / CGNAT (RFC 6598)"),
  cidr4("127.0.0.0/8", "loopback"),
  cidr4("169.254.0.0/16", "link-local — includes the 169.254.169.254 cloud metadata service"),
  cidr4("172.16.0.0/12", "private (RFC 1918)"),
  cidr4("192.0.0.0/24", "IETF protocol assignments"),
  cidr4("192.0.2.0/24", "documentation (TEST-NET-1)"),
  cidr4("192.88.99.0/24", "6to4 relay anycast"),
  cidr4("192.168.0.0/16", "private (RFC 1918)"),
  cidr4("198.18.0.0/15", "benchmarking"),
  cidr4("198.51.100.0/24", "documentation (TEST-NET-2)"),
  cidr4("203.0.113.0/24", "documentation (TEST-NET-3)"),
  cidr4("224.0.0.0/4", "multicast"),
  cidr4("240.0.0.0/4", "reserved"),
  cidr4("255.255.255.255/32", "broadcast"),
];

function ipv4Blocked(ip: string): string | null {
  const int = ipv4ToInt(ip);
  for (const range of BLOCKED_IPV4_RANGES) {
    if (matches4(int, range)) return range.note;
  }
  return null;
}

/**
 * Expands a normalised IPv6 literal (as `node:net.isIP` accepts it) to a
 * 128-bit integer. Handles `::` compression and a trailing embedded IPv4
 * literal (`::ffff:127.0.0.1`, `64:ff9b::10.0.0.1`) — both of which are real
 * ways to spell a blocked IPv4 address as IPv6, and must not slip past the
 * IPv4 check by never being converted.
 */
function ipv6ToBigInt(ip: string): bigint {
  const [headPart, tailPart] = ip.split("::");
  const head = headPart ? headPart.split(":") : [];
  const tail = tailPart ? tailPart.split(":") : [];

  // A trailing group containing a dot is an embedded IPv4 literal — expand it
  // to its two constituent 16-bit hex groups before the rest of this parses.
  function expandEmbeddedIpv4(groups: string[]): string[] {
    if (groups.length === 0) return groups;
    const last = groups[groups.length - 1];
    if (!last.includes(".")) return groups;
    const int = ipv4ToInt(last);
    const high = ((int >>> 16) & 0xffff).toString(16);
    const low = (int & 0xffff).toString(16);
    return [...groups.slice(0, -1), high, low];
  }

  const expandedHead = expandEmbeddedIpv4(head);
  const expandedTail = expandEmbeddedIpv4(tail);

  const missing = 8 - (expandedHead.length + expandedTail.length);
  const groups = ip.includes("::")
    ? [...expandedHead, ...Array(Math.max(missing, 0)).fill("0"), ...expandedTail]
    : expandedHead;

  let result = 0n;
  for (const group of groups) {
    result = (result << 16n) | BigInt(parseInt(group === "" ? "0" : group, 16));
  }
  return result;
}

function cidr6(cidr: string, note: string): Cidr6 {
  const [addr, bitsRaw] = cidr.split("/");
  return { base: ipv6ToBigInt(addr), bits: Number(bitsRaw), note };
}

function matches6(ip: bigint, range: Cidr6): boolean {
  if (range.bits === 0) return true;
  const mask = range.bits === 128 ? (1n << 128n) - 1n : ((1n << BigInt(range.bits)) - 1n) << BigInt(128 - range.bits);
  return (ip & mask) === (range.base & mask);
}

/**
 * IANA special-purpose IPv6 registry subset, plus the IPv4-mapped
 * (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) ranges — an address in either
 * of those encodes an IPv4 address, which is checked separately below rather
 * than by range membership here (an IPv4-mapped *public* address is fine; an
 * IPv4-mapped *private* one is what those two entries exist to catch).
 * [Source: IANA IPv6 Special-Purpose Address Registry,
 * https://www.iana.org/assignments/iana-ipv6-special-registry/ — `verified`]
 */
const BLOCKED_IPV6_RANGES: Cidr6[] = [
  cidr6("::1/128", "loopback"),
  cidr6("::/128", "unspecified"),
  cidr6("64:ff9b::/96", "NAT64 (embeds an IPv4 address)"),
  cidr6("100::/64", "discard-only"),
  cidr6("2001:db8::/32", "documentation"),
  cidr6("fc00::/7", "unique local (private)"),
  cidr6("fe80::/10", "link-local"),
  cidr6("ff00::/8", "multicast"),
];

/** Extracts the embedded IPv4 address from `::ffff:a.b.c.d` / `64:ff9b::a.b.c.d` forms, or null. */
function embeddedIpv4(ip: string): string | null {
  const match = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (!match) return null;
  // Only meaningful for the two encodings that actually carry an IPv4
  // address — a bare dotted-quad substring elsewhere would be a coincidence,
  // not an embedding, but both blocked prefixes are covered by the ranges
  // above, so any address reaching this branch is one of those two forms.
  return match[1];
}

function ipv6Blocked(ip: string): string | null {
  const embedded = embeddedIpv4(ip);
  if (embedded) {
    const blocked = ipv4Blocked(embedded);
    if (blocked) return `IPv4-mapped ${blocked}`;
  }
  const int = ipv6ToBigInt(ip);
  for (const range of BLOCKED_IPV6_RANGES) {
    if (matches6(int, range)) return range.note;
  }
  return null;
}

/** True when `ip` (already a literal, from `node:net.isIP`) is in a range this guard refuses to connect to. */
export function isBlockedAddress(ip: string): string | null {
  if (escapeHatchEnabled()) return null;
  const family = isIP(ip);
  if (family === 4) return ipv4Blocked(ip);
  if (family === 6) return ipv6Blocked(ip);
  return "not a literal IP address";
}

/**
 * Hostname syntax the guard accepts before it ever reaches DNS: RFC 1123
 * labels, dots, and a bare IP literal (`node:net.isIP` covers the latter, so
 * this pattern only has to admit hostname characters). Rejects embedded
 * whitespace, credentials-shaped input, and anything that is not a plausible
 * DNS name — this is a syntax gate, not the security control; the range
 * check after resolution is.
 */
const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,62})?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,62})?)*$/;

export type TargetRejectionReason =
  | "invalid-hostname"
  | "dns-resolution-failed"
  | "blocked-address";

export class TargetRejectedError extends Error {
  constructor(readonly reason: TargetRejectionReason, readonly host: string, detail: string) {
    super(`TLS probe target rejected (${reason}): ${detail}`);
    this.name = "TargetRejectedError";
  }
}

export interface ResolvedTarget {
  /** The literal address `tls.connect` must be given — never re-resolve `host` after this. */
  address: string;
  /** The original caller-supplied name, passed as `servername` for SNI and certificate hostname checks. */
  host: string;
  port: number;
}

/**
 * Resolves `host` to exactly one literal address and validates that address
 * — never the hostname string — against the blocklist. Throws
 * {@link TargetRejectedError} rather than returning a boolean: a caller must
 * not be able to forget the check by ignoring a return value, and the
 * rejection reason is for the server log only (see `tls-probe.ts` — the HTTP
 * response never repeats it, matching `parseGithubUrl`'s bare-`null` posture:
 * telling a caller *which* internal range they hit is itself information
 * disclosure about the deployment's network).
 */
export async function resolveAndValidateTarget(host: string, port: number): Promise<ResolvedTarget> {
  const literalFamily = isIP(host);
  let address: string;

  if (literalFamily !== 0) {
    address = host;
  } else {
    if (!HOSTNAME_PATTERN.test(host) || host.length > 253) {
      throw new TargetRejectedError("invalid-hostname", host, "not a well-formed hostname or IP literal");
    }
    let lookup: { address: string };
    try {
      // Single result, not `{ all: true }`: this is the ONE resolution this
      // whole request performs. `tls-probe.ts` must connect to exactly this
      // address and must never pass `host` itself to `tls.connect` — doing
      // so would re-resolve and reopen the DNS-rebinding gap this function
      // exists to close.
      lookup = await dns.lookup(host);
    } catch (err) {
      throw new TargetRejectedError(
        "dns-resolution-failed",
        host,
        err instanceof Error ? err.message : String(err),
      );
    }
    address = lookup.address;
  }

  const blockedReason = isBlockedAddress(address);
  if (blockedReason) {
    logger.warn({ host, address, port, reason: blockedReason }, "Refused a TLS probe target");
    throw new TargetRejectedError("blocked-address", host, `${address} is ${blockedReason}`);
  }

  return { address, host, port };
}

export const TLS_PROBE_ESCAPE_HATCH_ENV_VAR = ESCAPE_HATCH_ENV_VAR;
