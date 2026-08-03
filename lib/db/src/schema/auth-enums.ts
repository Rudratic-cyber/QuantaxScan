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
 * Deliberately minimal. `admin` is only worth a value once some permission
 * actually differs between it and `owner`; until then it is a label, and
 * widening this tuple later is a one-line diff.
 */
export const ORG_ROLE_VALUES = ["owner", "member"] as const;
export type OrgRole = (typeof ORG_ROLE_VALUES)[number];

export const IDENTITY_PROVIDER_VALUES = ["google", "github", "microsoft"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDER_VALUES)[number];

export const REPORT_VISIBILITY_VALUES = ["private", "public"] as const;
export type ReportVisibility = (typeof REPORT_VISIBILITY_VALUES)[number];
