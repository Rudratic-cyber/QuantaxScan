import type { Membership } from "./identity";
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
      role: string | null;
      /** Re-read from `organization_members` on every request, never cached. */
      memberships: Membership[];
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
