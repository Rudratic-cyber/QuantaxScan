import { Resolver } from "node:dns/promises";
import type { DnsResolution } from "@workspace/collectors";
import { logger } from "./logger";

/**
 * D8 — DNS corroboration of a CT-discovered name.
 *
 * ## Why this is corroboration and not discovery
 *
 * The obvious reading of "find hosts from DNS" is enumeration, and it is worth
 * saying plainly why this module does not do that. Enumerating names from DNS
 * needs one of two things:
 *
 *   - a **wordlist** — `www`, `mail`, `vpn`, `staging`, … tried against the
 *     domain. That is guessing. A hit is real (the name resolved), but the
 *     method's yield is a function of the wordlist rather than of the estate,
 *     so "we found 30 hosts" would mean "our wordlist happened to contain 30
 *     of your names" — a number that reads like coverage and is not;
 *   - a **zone transfer** (AXFR), which is a credential in all but name and is
 *     refused by every competently run nameserver.
 *
 * Neither is credential-free enumeration, so neither is here. What DNS *is*
 * uniquely good at is answering a question about a name you already have, and
 * that is the job it does in this feature: a CT log entry proves a certificate
 * was issued, and a DNS answer is the cheapest available evidence about
 * whether anything is there **now**. A name in a CT log that no longer
 * resolves is the single most common false lead this method produces.
 *
 * ## Three states, and why the third is the important one
 *
 * A resolver that times out, returns SERVFAIL, or cannot be reached has told
 * us *nothing*. Folding that into "does not resolve" would be a fabricated
 * negative — the mirror image of the fabricated positives the rest of this
 * lane guards against, and arguably worse here, because a fabricated negative
 * makes a real host disappear from an inventory. Only an authoritative
 * NXDOMAIN produces `not-resolved`. Everything else this cannot attribute is
 * `undetermined`, and a name never looked up at all stays NULL in the column.
 *
 * `ENODATA` — the name exists but has no A or AAAA record — is `undetermined`
 * rather than `not-resolved` for the same reason: it is a real name, it just
 * is not an address record. Reporting it as non-existent would be false.
 *
 * ## A lookup is not a probe
 *
 * This module resolves names. It never opens a connection to one. That
 * boundary is the whole reason `routes/discovery.ts` has a separate, explicitly
 * requested route for handing names to B3's prober — see the comment there.
 * A DNS query goes to the customer's resolver (or ours), not to the customer's
 * host, and it carries no traffic to a machine we have no consent to touch.
 */

const RESOLVER_ENV_VAR = "QUANTAXSCAN_DISCOVERY_DNS_SERVERS";

/** Per-name ceiling. This runs over a whole discovery result inside one HTTP request. */
export const DNS_LOOKUP_TIMEOUT_MS = 3_000;

/** Lookups in flight at once. Modest: this is outbound egress, not local CPU. */
export const DNS_LOOKUP_CONCURRENCY = 8;

/**
 * Names corroborated in one run.
 *
 * Below this, the run stops looking up and every remaining name keeps
 * `dnsResolution: null` — "nobody looked", which is exactly true and is a
 * fourth state the schema can express. Silently marking the remainder
 * `undetermined` would be almost right and therefore worse: it would claim a
 * lookup happened.
 */
export const MAX_DNS_LOOKUPS_PER_RUN = 250;

export interface DnsCorroboration {
  hostname: string;
  resolution: DnsResolution;
  /** Addresses returned, when any were. Empty for every state but `resolved`. */
  addresses: string[];
  checkedAt: Date;
}

/**
 * c-ares error codes that mean *the name authoritatively does not exist*.
 * Anything not on this list is `undetermined` — see the module comment.
 * [Source: Node `dns` error-code documentation; `NOTFOUND`/`ENOTFOUND` is
 * c-ares `ARES_ENOTFOUND`, the NXDOMAIN mapping.]
 */
const NXDOMAIN_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "NOTFOUND"]);

/**
 * A resolver, configured from the environment if asked.
 *
 * `QUANTAXSCAN_DISCOVERY_DNS_SERVERS` (comma-separated `ip` or `ip:port`)
 * repoints lookups at a specific nameserver. It has **no default** — unset
 * means the system resolver, which is what a deployment wants. It exists so
 * the e2e suite can stand up a real nameserver on loopback and get
 * deterministic answers without touching the public internet: this module's
 * code path stays identical, real UDP packets are still exchanged, and the
 * suite is not mocking anything.
 *
 * A `Resolver` rather than `dns.lookup`: `lookup` consults `/etc/hosts` and
 * the platform stub resolver, which collapses NXDOMAIN and "there is no
 * network" into the same `ENOTFOUND`. That collapse is precisely the
 * distinction this module exists to preserve, so it uses the DNS-protocol API
 * instead.
 */
function makeResolver(): Resolver {
  const resolver = new Resolver({ timeout: DNS_LOOKUP_TIMEOUT_MS, tries: 1 });
  const configured = process.env[RESOLVER_ENV_VAR];
  if (configured !== undefined && configured.trim().length > 0) {
    const servers = configured.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    try {
      resolver.setServers(servers);
    } catch (err) {
      logger.warn(
        { envVar: RESOLVER_ENV_VAR, servers, err: err instanceof Error ? err.message : String(err) },
        "Ignoring an unusable discovery resolver configuration; falling back to the system resolver",
      );
    }
  }
  return resolver;
}

function codeOf(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "";
}

/**
 * Looks one name up, and never throws.
 *
 * A lookup that fails is a fact about the lookup, not an error in the request:
 * one unresolvable name among four hundred must not fail a discovery run.
 */
async function corroborateOne(resolver: Resolver, hostname: string): Promise<DnsCorroboration> {
  const checkedAt = new Date();
  const addresses: string[] = [];
  let sawNxdomain = false;
  let sawUndetermined = false;

  // Both families, because a name may be v6-only. Either one answering is
  // evidence the name resolves; it takes *both* saying NXDOMAIN for the name
  // to be reported as non-existent. `allSettled` rather than two awaits: the
  // second promise would otherwise be created and left unobserved while the
  // first is in flight, which Node reports as an unhandled rejection.
  const settled = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      addresses.push(...outcome.value);
    } else if (NXDOMAIN_CODES.has(codeOf(outcome.reason))) {
      sawNxdomain = true;
    } else {
      sawUndetermined = true;
    }
  }

  if (addresses.length > 0) {
    return { hostname, resolution: "resolved", addresses, checkedAt };
  }
  // `sawUndetermined` wins over `sawNxdomain`: if one family said "no such
  // name" and the other said "I could not tell you", we could not tell.
  if (sawUndetermined || !sawNxdomain) {
    return { hostname, resolution: "undetermined", addresses: [], checkedAt };
  }
  return { hostname, resolution: "not-resolved", addresses: [], checkedAt };
}

/**
 * Corroborates up to {@link MAX_DNS_LOOKUPS_PER_RUN} names, returning a map
 * keyed by hostname. A name absent from the map was never looked up, which the
 * caller must persist as NULL rather than as any of the three values.
 */
export async function corroborateHostnames(hostnames: string[]): Promise<Map<string, DnsCorroboration>> {
  const resolver = makeResolver();
  const subject = hostnames.slice(0, MAX_DNS_LOOKUPS_PER_RUN);
  const results = new Map<string, DnsCorroboration>();

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= subject.length) return;
      const outcome = await corroborateOne(resolver, subject[i]);
      results.set(outcome.hostname, outcome);
    }
  }
  await Promise.all(Array.from({ length: Math.min(DNS_LOOKUP_CONCURRENCY, subject.length) }, worker));

  return results;
}

export const DISCOVERY_DNS_SERVERS_ENV_VAR = RESOLVER_ENV_VAR;
