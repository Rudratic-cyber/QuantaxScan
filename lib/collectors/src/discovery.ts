import { DISCOVERY_METHOD_VALUES, type DiscoveryMethod } from "./enums";

/**
 * D8 — host discovery from Certificate Transparency, the pure half.
 *
 * ## Why this exists
 *
 * Every other collector in this repo is *handed* its targets: the customer
 * names each host to probe, uploads each certificate, exports each key list.
 * Nothing enumerates anything, which makes total coverage impossible by
 * construction — you cannot inventory what nobody remembered to mention, and
 * the coverage meter cannot tell "we looked and found nothing" apart from
 * "nobody told us this existed". This module is the first thing in the product
 * that produces a name the customer did not supply.
 *
 * ## What a discovered name is, and what it is emphatically not
 *
 * **A name in a CT log is not a host, and it is not the customer's.** The
 * entire honesty problem of this feature is in that sentence, so it is worth
 * being concrete about what the evidence actually supports.
 *
 * A Certificate Transparency log (RFC 6962) is an append-only record of
 * certificates that CAs chose to log. An entry proves exactly one thing: at
 * the logged timestamp, some CA issued a certificate carrying this name. It
 * does **not** prove
 *
 *   - that a host ever existed at that name (staging names, names typed into a
 *     control panel once, names on a certificate that was issued and never
 *     deployed);
 *   - that anything is there *now* (the certificate may have expired in 2019);
 *   - that the customer owns or operates it (a SAN list routinely carries
 *     names belonging to several parties, and anyone may obtain a certificate
 *     for a name whose registrar-level ownership this product cannot see).
 *
 * So nothing here ever produces an `assets` row, a `RawObservation`, or a
 * `collection_runs` row. A discovered name is a **lead**: something a customer
 * may choose to point a collector at. It becomes evidence about cryptography
 * only when a collector actually examines it, and the record of what was found
 * says, in the payload, exactly which of the three claims above it supports —
 * which is one: "this name appeared in a public certificate-transparency log
 * entry for a certificate covering the domain you asked about".
 *
 * ## The false-positive controls, in one place
 *
 *   1. **Scope is matched at a label boundary, never as a substring.** See
 *      {@link isWithinDomain}. `example.com.attacker.test` and
 *      `notexample.com` both contain `example.com` and neither is within it.
 *      B6 shipped the substring version of this bug for algorithm tokens; this
 *      is the same bug in a domain.
 *   2. **A wildcard name is not a host.** `*.example.com` is evidence that a
 *      certificate covers some set of names, not that any particular one of
 *      them exists. Rejected, with a reason, rather than expanded or stripped
 *      to its base.
 *   3. **A name outside the requested domain is dropped, not recorded.** SAN
 *      lists routinely name other people's domains. Recording those would be
 *      attributing someone else's estate to this customer.
 *   4. **Every field is absent-not-invented.** A log entry that states no
 *      issuer, no serial, or no validity window yields `null` for those, never
 *      a placeholder — the same rule `assets.key_size` follows.
 *   5. **Rejections are counted and returned**, so a caller can see that 900
 *      names were read and 40 kept, rather than being shown 40 and left to
 *      assume that was everything.
 */

/**
 * Longest a DNS name may be, in presentation form. [Source: RFC 1035 §2.3.4 —
 * 255 octets of wire format, which is 253 characters written out.]
 */
const MAX_HOSTNAME_LENGTH = 253;

/**
 * One label of a hostname, already lowercased: letters, digits and hyphens,
 * not starting or ending with a hyphen, 1–63 characters. [Source: RFC 1123
 * §2.1 relaxing RFC 1035 §2.3.1 to permit a leading digit.]
 *
 * Underscores are **not** admitted. They appear in DNS (`_acme-challenge`,
 * SRV records) but not in a hostname, and a name that cannot be a host is not
 * a discovery target.
 */
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type CtNameRejectionReason =
  /** Not syntactically a hostname at all — empty labels, illegal characters, too long. */
  | "not-a-hostname"
  /** `*.example.com`: covers a set of names, evidence for none of them. */
  | "wildcard"
  /** A dotted-quad or other IP literal. A real target, but not a *name*, and this method discovers names. */
  | "ip-literal"
  /** Syntactically fine and genuinely someone else's — outside the domain the customer asked about. */
  | "out-of-scope";

/**
 * Normalises a name as a CT log states it into a comparable hostname, or
 * `null` if it is not one.
 *
 * Lowercases (DNS is case-insensitive and logs are inconsistent about it) and
 * strips a single trailing root dot. Everything else is a rejection, not a
 * repair: this function never *fixes* a name into something plausible, because
 * a repaired name is a name nobody has evidence for.
 */
export function normaliseHostname(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  const withoutRoot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (withoutRoot.length === 0 || withoutRoot.length > MAX_HOSTNAME_LENGTH) return null;

  const labels = withoutRoot.split(".");
  // A bare single label ("localhost", "intranet") is not something this
  // feature can act on: it is not resolvable outside a private search domain
  // and can never be *within* a customer's registered domain, so it would be
  // dropped as out-of-scope one step later anyway. Rejected here so the
  // reason reported is the accurate one.
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!HOSTNAME_LABEL.test(label)) return null;
  }

  // An all-numeric final label means this is an IPv4 literal (or a name that
  // could never be delegated — RFC 3696 §2). Callers distinguish this from a
  // malformed name because the two rejection reasons say different things
  // about the log entry.
  if (/^\d+$/.test(labels[labels.length - 1])) return null;

  return withoutRoot;
}

/** True when the log entry names a wildcard rather than a host. Checked before normalisation, which would reject `*` outright. */
export function isWildcardName(raw: string): boolean {
  return raw.trim().startsWith("*.");
}

/** True when `raw` is an IP literal rather than a name. Deliberately crude — it only has to separate two rejection reasons. */
function looksLikeIpLiteral(raw: string): boolean {
  const trimmed = raw.trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed) || trimmed.includes(":");
}

/**
 * Whether `hostname` is the domain itself or a subdomain of it — **matched at
 * a label boundary**, which is the whole point.
 *
 * `hostname.includes(domain)` and `hostname.endsWith(domain)` are both wrong
 * and both wrong in the direction that invents estate:
 *
 * ```
 * isWithinDomain("example.com.attacker.test", "example.com")  // false (endsWith would also say false, includes would say true)
 * isWithinDomain("notexample.com",            "example.com")  // false — endsWith WOULD say true
 * isWithinDomain("www.example.com",           "example.com")  // true
 * isWithinDomain("example.com",               "example.com")  // true
 * ```
 *
 * The second line is the one that matters: `notexample.com` is a different
 * registration, quite possibly a typosquat of the customer's, and claiming it
 * as the customer's host is precisely the false positive that destroys a
 * report's credibility in front of a regulator.
 *
 * Both arguments must already be normalised — pass them through
 * {@link normaliseHostname} first. A caller that skips that gets a
 * case-sensitive comparison and deserves to.
 */
export function isWithinDomain(hostname: string, domain: string): boolean {
  if (hostname === domain) return true;
  return hostname.endsWith(`.${domain}`);
}

/**
 * What a CT log entry says about the certificate the name came from. Every
 * field is nullable and nothing is defaulted: a log that states no issuer
 * yields `null`, never `"unknown"` — which would read as a value somebody
 * recorded.
 */
export interface CtCertificateEvidence {
  /** The log entry's own id at the source, so a reader can reopen the exact record. */
  entryId: number | null;
  /** The CA, verbatim as the log states it. Not parsed into a structure — nothing downstream needs one, and parsing it would invent structure the source did not supply. */
  issuerName: string | null;
  serialNumber: string | null;
  /** ISO-8601 UTC. Null when the entry states no validity window, or states one this cannot parse. */
  notBefore: string | null;
  notAfter: string | null;
  /** When the certificate was added to the log. */
  loggedAt: string | null;
  /** The exact string the entry carried, before normalisation — so the record of what was believed can be audited against what was said. */
  rawName: string;
}

export interface DiscoveredHostname {
  hostname: string;
  method: DiscoveryMethod;
  evidence: CtCertificateEvidence;
}

export interface RejectedCtName {
  rawName: string;
  reason: CtNameRejectionReason;
}

export interface CtDiscoveryResult {
  /** The normalised domain the search was for. */
  domain: string;
  /** Accepted names, deduplicated. Order is stable (alphabetical) so two runs of the same data produce the same payload. */
  hostnames: DiscoveredHostname[];
  /** Every name read and not accepted, with why. Returned rather than logged: a caller shown 40 of 900 names must be able to see that. */
  rejected: RejectedCtName[];
  /** Log entries read from the source. */
  entriesRead: number;
  /** Distinct names read across those entries, accepted or not. */
  namesRead: number;
  /** True when {@link MAX_DISCOVERED_HOSTNAMES_PER_RUN} was hit and the accepted list is therefore incomplete. Reported, never silent. */
  truncated: boolean;
}

/**
 * Ceiling on one run's accepted names.
 *
 * A CT search for a large organisation's domain legitimately returns tens of
 * thousands of names, and this runs inside an HTTP request. The number is a
 * pragmatic bound, not a claim about estate size — which is exactly why
 * {@link CtDiscoveryResult.truncated} exists and why every route that returns
 * this must pass it through. Silently trimming 4,000 names to 500 would make
 * "we know of N endpoints" a lie, and a lie in the one number this feature was
 * built to make honest.
 */
export const MAX_DISCOVERED_HOSTNAMES_PER_RUN = 500;

/**
 * The sentence every discovery response carries, in the payload rather than in
 * the documentation, for the same reason B3's `evidenceCaveat` is.
 */
export const DISCOVERY_EVIDENCE_CAVEAT =
  "Each name below appeared in a public certificate-transparency log entry for a certificate covering the domain " +
  "searched. That is the whole of the evidence: it is not a statement that this organisation owns or operates the " +
  "name, that a host exists there, or that anything is currently served from it. Names are unverified until a " +
  "collector examines one.";

/**
 * One row as the crt.sh JSON endpoint returns it.
 *
 * **Unverified against the live service.** This shape is transcribed from
 * crt.sh's documented `output=json` response and every field is optional here
 * because of that: a field the real service omits or renames yields `null`
 * rather than a parse failure or a fabricated value. A caller must not read
 * the absence of `issuerName` as "no issuer" — it means the source did not
 * tell us. See this module's Pending note in the lane report.
 */
export interface CrtShRow {
  id?: unknown;
  issuer_name?: unknown;
  common_name?: unknown;
  name_value?: unknown;
  not_before?: unknown;
  not_after?: unknown;
  entry_timestamp?: unknown;
  serial_number?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // crt.sh has been observed to render its bigint id as a JSON string. Accept
  // that, but only when the string is *entirely* an integer — a partial parse
  // would silently truncate an id into a different, valid-looking one.
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Parses a timestamp as CT sources state it, or returns `null`.
 *
 * crt.sh renders these without a timezone offset (`2024-01-01T00:00:00`).
 * JavaScript reads such a string as *local* time, which would shift every
 * certificate's validity by the server's offset — so a bare value is read as
 * UTC, which is what CT log timestamps are (RFC 6962 §3.2 defines the log
 * timestamp as milliseconds since the UNIX epoch, i.e. UTC). An offset the
 * source *does* state is honoured as stated.
 *
 * Anything unparseable is `null`. A date this cannot read is a date nobody
 * should act on.
 */
export function parseCtTimestamp(raw: unknown): string | null {
  const text = asString(raw);
  if (text === null) return null;
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text.trim());
  const parsed = new Date(naive ? `${text.trim().replace(" ", "T")}Z` : text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The names one crt.sh row carries. `name_value` is newline-separated and
 * holds the certificate's SAN list; `common_name` is the subject CN, which is
 * usually also in the SAN list but is not guaranteed to be.
 */
function namesIn(row: CrtShRow): string[] {
  const names: string[] = [];
  const nameValue = asString(row.name_value);
  if (nameValue !== null) names.push(...nameValue.split(/[\r\n]+/));
  const commonName = asString(row.common_name);
  if (commonName !== null) names.push(commonName);
  return names.map((n) => n.trim()).filter((n) => n.length > 0);
}

function evidenceFrom(row: CrtShRow, rawName: string): CtCertificateEvidence {
  return {
    entryId: asNumber(row.id),
    issuerName: asString(row.issuer_name),
    serialNumber: asString(row.serial_number),
    notBefore: parseCtTimestamp(row.not_before),
    notAfter: parseCtTimestamp(row.not_after),
    loggedAt: parseCtTimestamp(row.entry_timestamp),
    rawName,
  };
}

/**
 * Turns a crt.sh response into the names it supports and the names it does
 * not, for one domain.
 *
 * `domain` must already be normalised (see {@link normaliseHostname}); a
 * caller passing an unnormalised or invalid domain gets an empty result rather
 * than a partial match, because the alternative is matching against a string
 * that is not a domain.
 *
 * **Deduplication keeps the evidence from the certificate with the latest
 * `notAfter`.** One name is typically issued dozens of times; the interesting
 * record is the most recent one, because "the only certificate ever seen for
 * this name expired in 2019" and "there is one valid until next March" are
 * very different statements about the same name. An entry with no stated
 * `notAfter` never displaces one that has one — an absent date must not win a
 * comparison against a real one.
 */
export function parseCrtShResponse(rows: unknown, domain: string): CtDiscoveryResult {
  const empty: CtDiscoveryResult = {
    domain,
    hostnames: [],
    rejected: [],
    entriesRead: 0,
    namesRead: 0,
    truncated: false,
  };

  if (normaliseHostname(domain) !== domain) return empty;
  if (!Array.isArray(rows)) return empty;

  const accepted = new Map<string, DiscoveredHostname>();
  const rejected = new Map<string, CtNameRejectionReason>();
  const seenNames = new Set<string>();
  let truncated = false;
  let entriesRead = 0;

  for (const row of rows as CrtShRow[]) {
    if (row === null || typeof row !== "object") continue;

    for (const rawName of namesIn(row)) {
      seenNames.add(rawName);

      if (isWildcardName(rawName)) {
        rejected.set(rawName, "wildcard");
        continue;
      }
      if (looksLikeIpLiteral(rawName)) {
        rejected.set(rawName, "ip-literal");
        continue;
      }

      const hostname = normaliseHostname(rawName);
      if (hostname === null) {
        rejected.set(rawName, "not-a-hostname");
        continue;
      }
      if (!isWithinDomain(hostname, domain)) {
        rejected.set(rawName, "out-of-scope");
        continue;
      }

      const evidence = evidenceFrom(row, rawName);
      const held = accepted.get(hostname);
      if (held === undefined) {
        if (accepted.size >= MAX_DISCOVERED_HOSTNAMES_PER_RUN) {
          truncated = true;
          continue;
        }
        accepted.set(hostname, { hostname, method: DISCOVERY_METHOD_VALUES[0], evidence });
        continue;
      }
      // Later `notAfter` wins. An absent one never displaces a stated one.
      if (evidence.notAfter !== null && (held.evidence.notAfter === null || evidence.notAfter > held.evidence.notAfter)) {
        accepted.set(hostname, { hostname, method: DISCOVERY_METHOD_VALUES[0], evidence });
      }
    }

    entriesRead += 1;
  }

  return {
    domain,
    hostnames: [...accepted.values()].sort((a, b) => a.hostname.localeCompare(b.hostname)),
    rejected: [...rejected.entries()]
      .map(([rawName, reason]) => ({ rawName, reason }))
      .sort((a, b) => a.rawName.localeCompare(b.rawName)),
    entriesRead,
    namesRead: seenNames.size,
    truncated,
  };
}

/**
 * True when the newest certificate evidence for a name expired before `asOf`.
 *
 * Derived on read, never stored — the same discipline as `resolveSecrecyLifetime()`
 * and `assessOtExposure()`: a stored "expired" flag is wrong the day after it
 * is written. `null` when the evidence states no `notAfter` at all, which is
 * "we cannot tell", not "not expired".
 */
export function certificateExpired(evidence: CtCertificateEvidence, asOf: Date): boolean | null {
  if (evidence.notAfter === null) return null;
  return new Date(evidence.notAfter).getTime() < asOf.getTime();
}
