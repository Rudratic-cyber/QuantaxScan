import type { Membership, DivisionGrant } from "./identity";
import type { OrgRole } from "@workspace/db/roles";
import type { OAuthTransaction } from "./providers";

/**
 * What a request is authenticated as — docs/Claude/13-auth-and-tenancy.md §6.1.
 *
 * Exactly one of three, resolved once per request by `resolvePrincipal` and
 * never re-derived. Everything downstream reads `req.principal`; nothing else
 * decides which organisation a request acts in.
 */
export type Principal =
  | {
      kind: "apiKey";
      /** From the positional QUANTAXSCAN_API_KEY_ORG_IDS binding. */
      organizationId: number;
      /** Empty string: a machine credential has no person behind it. */
      userId: "";
      /**
       * From the positional QUANTAXSCAN_API_KEY_ROLES binding, defaulting to
       * `admin`. Without a role here RBAC would be bypassable by the one
       * credential every deployment already holds — 15-rbac-design.md §4.5.
       */
      role: OrgRole;
      /**
       * Always empty: an API key is not scoped to a division, it acts at its
       * role across the whole organisation. Empty means *unrestricted*, which
       * is the same encoding the GUC uses — see `divisionIds` below.
       */
      divisionIds: readonly number[];
    }
  | {
      kind: "session";
      userId: string;
      /**
       * Null when the user belongs to no organisation — a real state after a
       * revocation, and NOT a reason to fall back to a default. Org-scoped
       * routes refuse a principal in this state.
       */
      organizationId: number | null;
      /**
       * The organisation-level role, re-read every request. It is a **floor**:
       * a division grant can raise the effective role on that division's
       * projects and never lower it (15-rbac-design.md §2).
       */
      role: string | null;
      /** Re-read from `organization_members` on every request, never cached. */
      memberships: Membership[];
      /**
       * Divisions this principal may see, and **empty means unrestricted**.
       *
       * The encoding matters. An org `admin` or `owner` sees every division —
       * that is what makes them an administrator — and carries an empty list.
       * A `member` or `viewer` carries the divisions they hold a grant on, and
       * is restricted to those plus organisation-wide rows. Encoding
       * "unrestricted" as empty rather than a magic value keeps the policy
       * expression simple and fails the right way: a caller with *some*
       * divisions is confined to them.
       */
      divisionIds: readonly number[];
      /** Grants held, for the management surface and for explaining a refusal. */
      divisionGrants: DivisionGrant[];
    }
  | { kind: "anonymous" };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

declare module "express-session" {
  interface SessionData {
    /** Set only by the callback handler, after `regenerate()`. */
    userId?: string;
    /**
     * A CACHE of the last resolved organisation, and never a grant. It is only
     * honoured when it still appears in the memberships re-read this request
     * (§6.3) — which is what makes a revocation take effect on the next
     * request rather than at cookie expiry.
     */
    organizationId?: number;
    loginAt?: number;
    /**
     * `rolling` alone extends a session indefinitely, so the absolute cap
     * lives in the payload and is enforced in `resolvePrincipal`.
     */
    absoluteExpiresAt?: number;
    /** The in-flight OAuth transaction. Single-use; deleted before the exchange. */
    oauth?: OAuthTransaction;
  }
}

export {};
