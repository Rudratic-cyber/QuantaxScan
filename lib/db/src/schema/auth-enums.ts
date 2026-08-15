/**
 * Auth and tenancy enums.
 *
 * A deliberate, recorded deviation from AGENTS.md's rule that shared enums
 * needing both a DB constraint and a TypeScript type are defined once in
 * `@workspace/collectors`. That rule exists because those enums are part of
 * the *collector* contract, and `lib/collectors` is deliberately
 * dependency-free so it can ship as a standalone on-prem agent. An on-prem
 * collector has no concept of an organisation role or an identity provider;
 * putting them there would push tenancy into the one artefact whose whole
 * point is that it carries none.
 *
 * The rule's mechanism is preserved exactly: one const tuple, `text` +
 * `CHECK` via `oneOf()` from `sql-helpers.ts`, never a Postgres `ENUM` type —
 * narrowing an `ENUM` means recreating it, narrowing a `CHECK` built from the
 * same tuple is a one-line diff.
 *
 * See docs/Claude/13-auth-and-tenancy.md §4.1.
 */

/**
 * Organisation-level roles, widened from `["owner", "member"]` on 2026-08-15
 * because permissions now actually differ between them — see
 * docs/Claude/15-rbac-design.md §3 for the capability matrix, which is the
 * authority on what each one may do.
 *
 * **Ordered weakest to strongest, and the order is load-bearing.**
 * `roleAtLeast()` compares by index, so inserting a value in the middle
 * changes what every existing grant permits. Append, or renumber deliberately.
 *
 * Each value earns its place by having something the one below it may not do:
 * a viewer reads and writes nothing; a member submits collections but holds no
 * credential; an admin manages members and credentials but cannot delete the
 * tenant; an owner can.
 */
export const ORG_ROLE_VALUES = ["viewer", "member", "admin", "owner"] as const;
export type OrgRole = (typeof ORG_ROLE_VALUES)[number];

/**
 * Roles grantable on a *division*. The same vocabulary minus `owner`:
 * ownership is a fact about the tenant, not about one division of it, and a
 * "division owner" would imply a right to delete something they do not own.
 */
export const DIVISION_ROLE_VALUES = ["viewer", "member", "admin"] as const;
export type DivisionRole = (typeof DIVISION_ROLE_VALUES)[number];

/**
 * Is `role` at least as strong as `atLeast`? The single comparison every gate
 * uses, so the ordering above has exactly one reader.
 *
 * Unknown values answer `false` rather than throwing: a role that is not in
 * the tuple is one this build does not understand, and the safe reading of
 * "I do not know what this is" is "not permitted", never "permitted".
 */
export function roleAtLeast(role: string | null | undefined, atLeast: OrgRole): boolean {
  const held = ORG_ROLE_VALUES.indexOf(role as OrgRole);
  if (held < 0) return false;
  return held >= ORG_ROLE_VALUES.indexOf(atLeast);
}

/** The stronger of two roles, for combining an org role with a division grant. Null-safe on both sides. */
export function strongerRole(a: string | null | undefined, b: string | null | undefined): OrgRole | null {
  const ai = ORG_ROLE_VALUES.indexOf(a as OrgRole);
  const bi = ORG_ROLE_VALUES.indexOf(b as OrgRole);
  const best = Math.max(ai, bi);
  return best < 0 ? null : (ORG_ROLE_VALUES[best] as OrgRole);
}

export const IDENTITY_PROVIDER_VALUES = ["google", "github", "microsoft"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDER_VALUES)[number];

export const REPORT_VISIBILITY_VALUES = ["private", "public"] as const;
export type ReportVisibility = (typeof REPORT_VISIBILITY_VALUES)[number];
