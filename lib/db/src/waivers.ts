/**
 * C8 — what a waiver *is* right now. Pure, clock-injectable, drizzle-free.
 *
 * This module exists so that "is this waiver still a waiver?" is answered in
 * exactly one place. The constraint C8 was given is that an expired waiver must
 * not quietly keep suppressing a finding, and the way that goes wrong is not a
 * missing check — it is *two* checks, in a route and in a summariser, that
 * disagree by a fraction of a second or by a `>` versus a `>=`.
 *
 * So there is no `where expires_at > now()` anywhere in this codebase. Every
 * read selects the waivers whole and calls `resolveWaiverStatus()`, which means
 * the register and the inventory annotation are incapable of disagreeing, and
 * an expiry test needs a `now` argument rather than a sleep.
 *
 * Same shape as `classification.ts`: a `lib/db` module that holds a rule about
 * rows, imported by the API server rather than reimplemented there.
 */

/**
 * The three states, in precedence order.
 *
 *   * `revoked`  — somebody withdrew it. Beats expiry: a waiver revoked in
 *                  March and due to expire in June was revoked, and saying
 *                  "expired" in July would misreport why it stopped applying.
 *   * `expired`  — its time ran out.
 *   * `active`   — neither. The only status that suppresses anything.
 */
export const WAIVER_STATUS_VALUES = ["active", "expired", "revoked"] as const;
export type WaiverStatus = (typeof WAIVER_STATUS_VALUES)[number];

/** The columns the status depends on, and nothing else — so callers may pass a narrowed select. */
export interface WaiverTiming {
  expiresAt: Date | string;
  revokedAt: Date | string | null;
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function resolveWaiverStatus(waiver: WaiverTiming, now: Date): WaiverStatus {
  if (waiver.revokedAt !== null && waiver.revokedAt !== undefined) return "revoked";
  // `<=`, not `<`. A waiver expiring at exactly `now` has expired: the boundary
  // has to fall one way, and the direction that fails is the one that keeps
  // suppressing.
  return toMillis(waiver.expiresAt) <= now.getTime() ? "expired" : "active";
}

export function isWaiverActive(waiver: WaiverTiming, now: Date): boolean {
  return resolveWaiverStatus(waiver, now) === "active";
}

/**
 * The waiver that actually applies, out of however many an asset has collected.
 *
 * Multiple rows per asset are legitimate and deliberately not prevented by a
 * unique index: a risk accepted for ninety days and then accepted again is two
 * decisions, and collapsing them would erase the first. The one that applies is
 * the active one that runs longest — anything else would let an about-to-expire
 * waiver hide a fresh one and produce a re-appearing finding on a day nobody
 * chose.
 *
 * Returns `null` when every waiver on the asset is expired or revoked, which is
 * the same answer as having none. That equivalence is the point.
 */
export function activeWaiver<T extends WaiverTiming>(waivers: readonly T[], now: Date): T | null {
  let best: T | null = null;
  for (const waiver of waivers) {
    if (!isWaiverActive(waiver, now)) continue;
    if (best === null || toMillis(waiver.expiresAt) > toMillis(best.expiresAt)) best = waiver;
  }
  return best;
}

/**
 * Whether the platform verified the name in `signed_off_by`, or is only
 * repeating it.
 *
 * Reported rather than hidden. A waiver written by the shared API key names
 * whoever the caller typed, and calling that a signature would be the same
 * mistake as storing a resolved obligation on a row: it turns an assertion into
 * a fact by writing it down.
 */
export function waiverAttribution(signedOffByUserId: string | null): "authenticated" | "asserted" {
  return signedOffByUserId === null || signedOffByUserId === "" ? "asserted" : "authenticated";
}
