import { isIP } from "node:net";
import dns from "node:dns/promises";
import { parseCrtShResponse, normaliseHostname, type CtDiscoveryResult } from "@workspace/collectors";
import { isBlockedAddress } from "./tls-ssrf-guard";
import { logger } from "./logger";

/**
 * D7 — the Certificate Transparency query, the I/O half.
 *
 * `@workspace/collectors`'s `discovery.ts` is the pure mapping from a CT
 * response to hostnames and has no network code at all; this is the only place
 * in the feature that makes an HTTP request.
 *
 * ## This is the second outbound egress path in the codebase, and it is the
 * ## *shape* of `github-url.ts`, not the shape of `tls-ssrf-guard.ts`
 *
 * That distinction decides the whole design here, so it is worth being precise
 * about it.
 *
 *   - B3's TLS prober lets a **caller name the host** it connects to. That is
 *     genuine SSRF surface, and it needs resolve-then-pin plus a range
 *     blocklist (see `tls-ssrf-guard.ts`).
 *   - `github-url.ts` always talks to a **fixed host**; only the path is
 *     caller-influenced. Its own writeup concluded that its reachable surface
 *     was therefore not actually SSRF.
 *
 * This module is the second kind. The host is fixed —
 * {@link CT_LOG_DEFAULT_BASE_URL}, allowlisted in {@link ALLOWED_CT_HOSTS} —
 * and the only caller-influenced value is the **domain**, which lands in a
 * query parameter. That value is run through `normaliseHostname()` before it is
 * used at all (so it is letters, digits, hyphens and dots or it is rejected)
 * and then `encodeURIComponent`d, which is belt and braces: a string that
 * survives the first cannot contain anything the second would have to escape.
 *
 * ## The one thing an operator can change, and the guard on it
 *
 * `QUANTAXSCAN_CT_LOG_BASE_URL` repoints this at a different CT source — a
 * mirror, an internal cache, or the e2e suite's local fixture server. It has
 * **no default**, so a deployment that has not set it talks to crt.sh and
 * nothing else, and setting it is an explicit operator act rather than
 * something that can happen by accident.
 *
 * It is still guarded, because the failure mode of a mis-set value is severe:
 * `QUANTAXSCAN_CT_LOG_BASE_URL=http://169.254.169.254/` would turn this route
 * into a proxy for the cloud metadata service. So the configured host is
 * resolved and range-checked with the same {@link isBlockedAddress} the TLS
 * prober uses, and a private/loopback/link-local result is refused unless
 * `QUANTAXSCAN_DISCOVERY_ALLOW_PRIVATE_SOURCES=1` is *also* set. Two
 * deliberate variables, because the e2e suite legitimately needs a loopback
 * fixture and production legitimately must never reach one — the same
 * reasoning, and the same no-default posture, as
 * `QUANTAXSCAN_TLS_PROBE_ALLOW_PRIVATE_TARGETS`.
 *
 * Note what the range check here does *not* buy: this is defence against a
 * misconfiguration, not against an attacker, because the value is not
 * caller-influenced in the first place. Stated that way rather than claimed as
 * an SSRF control.
 */

/** The public CT search this feature was written against. [Source: crt.sh, the Sectigo-operated CT log search, `output=json` endpoint.] */
export const CT_LOG_DEFAULT_BASE_URL = "https://crt.sh";

/** Hosts this server will issue a CT query to with no operator override. Compared with `===`, never `includes`. */
export const ALLOWED_CT_HOSTS: ReadonlySet<string> = new Set(["crt.sh"]);

const BASE_URL_ENV_VAR = "QUANTAXSCAN_CT_LOG_BASE_URL";
const ALLOW_PRIVATE_ENV_VAR = "QUANTAXSCAN_DISCOVERY_ALLOW_PRIVATE_SOURCES";

/** Per-request ceiling. crt.sh is a public service under load and a slow answer is common. */
export const CT_LOG_TIMEOUT_MS = 20_000;

/**
 * Hard cap on the response body this will read.
 *
 * A CT search for a large domain can return many megabytes, and this runs
 * inside an HTTP request. Truncating JSON produces a parse failure, not a
 * partial answer — which is the correct outcome: half a CT response silently
 * parsed would understate the estate while looking complete, and understating
 * the estate is the exact failure this feature exists to fix.
 */
export const CT_LOG_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function allowPrivateSources(): boolean {
  return process.env[ALLOW_PRIVATE_ENV_VAR] === "1";
}

if (process.env[BASE_URL_ENV_VAR] !== undefined) {
  logger.warn(
    { envVar: BASE_URL_ENV_VAR, value: process.env[BASE_URL_ENV_VAR] },
    "Certificate-transparency queries are pointed at a non-default source. Discovery results will be whatever that source returns.",
  );
}
if (allowPrivateSources()) {
  logger.warn(
    { envVar: ALLOW_PRIVATE_ENV_VAR },
    "Discovery will accept a certificate-transparency source on a loopback/private/link-local address. This must never be set in a production deployment.",
  );
}

export type CtQueryFailure =
  /** The domain was not a domain. Nothing was requested. */
  | "invalid-domain"
  /** The configured source is not a usable http(s) URL, or is not allowlisted, or resolves into a blocked range. */
  | "source-unavailable"
  /** The source answered with a non-2xx status. */
  | "source-error"
  /** The source did not answer in time, or the connection failed. */
  | "source-unreachable"
  /** The source answered with something that is not the JSON array this expects — including a body truncated at the byte cap. */
  | "unreadable-response";

export class CtQueryError extends Error {
  constructor(readonly reason: CtQueryFailure, detail: string) {
    super(`Certificate-transparency query failed (${reason}): ${detail}`);
    this.name = "CtQueryError";
  }
}

/** The configured source, read per call so a test can set it after this module loads. */
export function ctLogBaseUrl(): string {
  return process.env[BASE_URL_ENV_VAR] ?? CT_LOG_DEFAULT_BASE_URL;
}

/**
 * Validates the configured source and returns its origin, or throws.
 *
 * Deliberately throws rather than returning null: a caller must not be able to
 * skip this by ignoring a return value, the same reasoning as
 * `resolveAndValidateTarget`.
 */
async function validatedSourceUrl(): Promise<URL> {
  const raw = ctLogBaseUrl();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CtQueryError("source-unavailable", `${BASE_URL_ENV_VAR} is not a URL`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CtQueryError("source-unavailable", `${url.protocol} is not an http(s) scheme`);
  }

  // The default host, and any host an operator explicitly allowlists here, is
  // public and needs no range check. Anything else is an override, and the
  // override is what the range check exists for.
  if (ALLOWED_CT_HOSTS.has(url.hostname)) return url;

  let address: string;
  if (isIP(url.hostname) !== 0) {
    address = url.hostname;
  } else {
    try {
      address = (await dns.lookup(url.hostname)).address;
    } catch (err) {
      throw new CtQueryError("source-unavailable", err instanceof Error ? err.message : String(err));
    }
  }

  if (!allowPrivateSources()) {
    // Known coupling, recorded rather than hidden: `isBlockedAddress` returns
    // null unconditionally when B3's own hatch
    // (`QUANTAXSCAN_TLS_PROBE_ALLOW_PRIVATE_TARGETS`) is set, so setting that
    // also widens this check. Both variables have no default and neither is
    // set by any shipped configuration, so the widening can only happen in a
    // deployment that has already opted out of the range check once.
    const blocked = isBlockedAddress(address);
    if (blocked) {
      logger.warn({ host: url.hostname, address, reason: blocked }, "Refused a certificate-transparency source");
      throw new CtQueryError("source-unavailable", `${address} is ${blocked}`);
    }
  }

  return url;
}

/** Reads at most {@link CT_LOG_MAX_RESPONSE_BYTES}, then gives up. A truncated body must fail to parse rather than parse partially. */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CT_LOG_MAX_RESPONSE_BYTES) {
        throw new CtQueryError(
          "unreadable-response",
          `response exceeded ${CT_LOG_MAX_RESPONSE_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Asks the configured CT source about `domain` and returns what its answer
 * supports.
 *
 * The `%.` prefix is crt.sh's own wildcard for "this name and anything under
 * it" — and note that it is a *SQL LIKE* wildcard, which is exactly why
 * {@link parseCrtShResponse} re-checks every returned name at a label boundary
 * rather than trusting the query to have scoped the answer. `%.example.com`
 * matches `notexample.com` at the source. Trusting a substring query to have
 * done the scoping is how a lookalike domain ends up in a customer's
 * inventory.
 */
export async function queryCertificateTransparency(domain: string): Promise<CtDiscoveryResult> {
  const normalised = normaliseHostname(domain);
  if (normalised === null) {
    throw new CtQueryError("invalid-domain", "not a well-formed domain name");
  }

  const base = await validatedSourceUrl();
  const url = new URL(base.toString());
  url.search = new URLSearchParams({ q: `%.${normalised}`, output: "json" }).toString();

  let response: Response;
  try {
    response = await fetch(url, {
      // A CT source has no business redirecting a JSON query, and following
      // one would leave the allowlist. Refused outright rather than followed
      // hop-by-hop the way `githubFetch` does for a renamed repository.
      redirect: "error",
      signal: AbortSignal.timeout(CT_LOG_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (err) {
    throw new CtQueryError("source-unreachable", err instanceof Error ? err.message : String(err));
  }

  if (!response.ok) {
    throw new CtQueryError("source-error", `HTTP ${response.status}`);
  }

  const text = await readCapped(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CtQueryError("unreadable-response", err instanceof Error ? err.message : String(err));
  }

  return parseCrtShResponse(parsed, normalised);
}

export const CT_LOG_BASE_URL_ENV_VAR = BASE_URL_ENV_VAR;
export const DISCOVERY_ALLOW_PRIVATE_SOURCES_ENV_VAR = ALLOW_PRIVATE_ENV_VAR;
