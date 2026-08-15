/**
 * D8 — turning discovered targets into the denominator the coverage meter has
 * never had.
 *
 * Today `GET /projects/:id/coverage` can say "the tls surface has 12 assets".
 * What it cannot say — because until this lane nothing enumerated anything —
 * is how many hosts there *are*. Twelve out of twelve and twelve out of four
 * hundred are the same payload, and a CISO reading the first as the second is
 * the failure this module exists to stop.
 *
 * ## Examined-ness is derived, never stored
 *
 * `discovered_targets` has no `examined_at` column on purpose. Whether a
 * collector has looked at a name is a fact about `assets`, and a copy of that
 * fact kept on another table can disagree with it — after an asset is deleted,
 * after a project is reconciled, after a probe that was recorded but rolled
 * back. So it is computed on read from `assets.location`, the same discipline
 * `resolveSecrecyLifetime()`, `assessOtExposure()` and the C1 mapping engine
 * follow.
 *
 * The join key is the `project:<id>:<host>:<port>` location convention that
 * `ingestTlsObservations` writes (via `projectRepoId()`), which
 * `tests/e2e/05-tls.spec.ts` asserts end to end.
 */

export interface DiscoveryCoverage {
  /** Names discovery knows about for this project. Not an estimate of the estate — see `basis`. */
  knownTargets: number;
  /** Of those, how many a collector has actually examined. */
  examinedTargets: number;
  unexaminedTargets: number;
  /**
   * Stated in the payload so a report generated from it quotes the basis
   * rather than inventing one. This ratio is **not** estate coverage:
   * certificate transparency only reveals names that were given a publicly
   * logged certificate, so a host with no certificate — an internal service, a
   * database, an IP-only endpoint — is invisible to this method and absent
   * from `knownTargets` entirely. The honest reading is "of the names we know
   * of, this many have been examined", never "this fraction of the estate".
   */
  basis: "discovered names examined by a collector, out of discovered names known";
}

export const DISCOVERY_COVERAGE_BASIS: DiscoveryCoverage["basis"] =
  "discovered names examined by a collector, out of discovered names known";

/**
 * Pulls the hostname out of a `tls`-surface asset location, or returns null.
 *
 * The format is `<repo>:<host>:<port>` where `<repo>` is itself
 * `project:<id>`. A hostname cannot contain a colon and a port is digits, so
 * this splits unambiguously — and anything that does not match exactly is
 * `null` rather than a best guess, because a mis-parsed location would mark
 * the wrong name examined.
 */
export function hostnameFromTlsAssetLocation(repo: string, location: string): { hostname: string; port: number } | null {
  if (!location.startsWith(`${repo}:`)) return null;
  const rest = location.slice(repo.length + 1);
  const parts = rest.split(":");
  if (parts.length !== 2) return null;
  const [hostname, portRaw] = parts;
  if (hostname.length === 0 || !/^\d+$/.test(portRaw)) return null;
  const port = Number(portRaw);
  if (port < 1 || port > 65535) return null;
  return { hostname: hostname.toLowerCase(), port };
}

/** Every `<host, port>` a `tls` asset of this project records, keyed by hostname. */
export function examinedHostPorts(repo: string, locations: Iterable<string>): Map<string, number[]> {
  const byHost = new Map<string, number[]>();
  for (const location of locations) {
    const parsed = hostnameFromTlsAssetLocation(repo, location);
    if (parsed === null) continue;
    const ports = byHost.get(parsed.hostname);
    if (ports === undefined) byHost.set(parsed.hostname, [parsed.port]);
    else if (!ports.includes(parsed.port)) ports.push(parsed.port);
  }
  for (const ports of byHost.values()) ports.sort((a, b) => a - b);
  return byHost;
}

/**
 * The "we know of N and have probed M" arithmetic.
 *
 * `examinedHostnames` may legitimately contain names that were never
 * discovered — a customer who typed a host into `POST /projects/:id/tls` by
 * hand has examined something discovery never found. Those are **not** counted
 * in `knownTargets`, because this is a statement about the discovered set, and
 * inflating the denominator with hosts discovery did not find would make the
 * ratio describe something else.
 */
export function summariseDiscoveryCoverage(input: {
  hostnames: Iterable<string>;
  examinedHostnames: Iterable<string>;
}): DiscoveryCoverage {
  const known = new Set(input.hostnames);
  const examined = new Set(input.examinedHostnames);

  let examinedTargets = 0;
  for (const hostname of known) {
    if (examined.has(hostname)) examinedTargets += 1;
  }

  return {
    knownTargets: known.size,
    examinedTargets,
    unexaminedTargets: known.size - examinedTargets,
    basis: DISCOVERY_COVERAGE_BASIS,
  };
}
