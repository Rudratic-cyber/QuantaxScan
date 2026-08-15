import { isIP } from "node:net";
import { normaliseHostname } from "@workspace/collectors";

/**
 * G-23 — is this string something we could actually dial?
 *
 * `CreateCollectionScheduleBody.targets[].host` documented itself as
 * "Hostname or IP literal. Never a URL — no scheme, path or credentials" and
 * nothing enforced it, so `https://example.test/path` was accepted and stored
 * with a `201`. Not a security hole — B3's resolve-then-pin guard refuses it at
 * probe time — but a schedule that can never succeed, saved as though it were
 * fine, under a description telling the reader we checked. That is the
 * silently-wrong-rather-than-an-error failure this register keeps returning to.
 *
 * **Composed, not reimplemented.** The hostname rule is D8's
 * `normaliseHostname` (`lib/collectors/src/discovery.ts`) — RFC 1123 labels,
 * lower-cased, one trailing root dot stripped, wildcards and single labels
 * refused. A second hostname validator would drift from the first, and a
 * validator that disagrees with the one beside it is a lie of its own. What is
 * added here is only the half D8 deliberately excludes: `normaliseHostname`
 * rejects IP literals because *discovery* discovers names, whereas a
 * collection target may legitimately be an address, so `node:net`'s `isIP`
 * covers that case and nothing else.
 *
 * Returns the normalised value so the caller stores one canonical form —
 * `EXAMPLE.test.` and `example.test` must not become two schedules for one host.
 */
export function normaliseTargetHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // An IP literal is already canonical; `isIP` returns 0 for anything else.
  // Checked first because `normaliseHostname` deliberately refuses these.
  if (isIP(trimmed) !== 0) return trimmed;

  // IPv6 is routinely written bracketed when it sits beside a port. Accept the
  // bracketed form and store it unbracketed, so one address is one target.
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    return isIP(inner) !== 0 ? inner : null;
  }

  return normaliseHostname(trimmed);
}

/**
 * The message a caller gets back. Names what was wrong with *their* input
 * rather than restating the rule, because "example.com/path is not a hostname"
 * is actionable and "must match RFC 1123" is not.
 */
export function targetHostRejection(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("://")) {
    return `"${raw}" is a URL. Give the host on its own — no scheme, path or credentials — and set the port separately.`;
  }
  if (trimmed.includes("/")) {
    return `"${raw}" contains a path. A collection target is a host and a port, not a URL.`;
  }
  if (trimmed.startsWith("*")) {
    return `"${raw}" is a wildcard. A schedule collects from one host at a time, so name each one.`;
  }
  if (trimmed.includes(":") && isIP(trimmed) === 0) {
    return `"${raw}" looks like it carries a port. Put the port in the target's own \`port\` field.`;
  }
  return `"${raw}" is not a hostname or IP address.`;
}
