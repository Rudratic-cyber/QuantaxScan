import type { Request } from "express";
import type { OrgContext } from "@workspace/db/org-scope";
import { logger } from "./logger";

/**
 * Which organisation a request acts as.
 *
 * Today there is exactly one authenticated principal: the shared API key. It
 * is a **break-glass and machine credential** — CI, the backfill scripts, any
 * server-to-server caller — not the user path, and it is now explicitly bound
 * to one organisation by configuration. That binding is the difference between
 * the interim control and the finished one: the key can no longer read
 * everything, only `QUANTAXSCAN_API_KEY_ORG_ID`'s data.
 *
 * The default is organisation 1, which is the organisation every pre-existing
 * row already belongs to. That is what makes this phase invisible: every
 * existing caller sees exactly what it saw before.
 *
 * When per-user sign-in lands this grows into `resolvePrincipal`, returning
 * one of session / apiKey / anonymous. Deliberately not built here — a session
 * with no way to sign in is not worth the surface.
 *
 * See docs/Claude/13-auth-and-tenancy.md §6.1.
 */

const ENV_VAR = "QUANTAXSCAN_API_KEY_ORG_ID";
const DEFAULT_API_KEY_ORGANIZATION_ID = 1;

function parseOrganizationId(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_API_KEY_ORGANIZATION_ID;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${ENV_VAR} must be a positive integer organisation id, got "${raw}". ` +
        `Leave it unset for the default (${DEFAULT_API_KEY_ORGANIZATION_ID}).`,
    );
  }
  return parsed;
}

export const API_KEY_ORGANIZATION_ID: number = parseOrganizationId(process.env[ENV_VAR]);

if (API_KEY_ORGANIZATION_ID !== DEFAULT_API_KEY_ORGANIZATION_ID) {
  logger.info({ organizationId: API_KEY_ORGANIZATION_ID }, "Shared API key is bound to a non-default organisation");
}

/**
 * The organisation context for an authenticated request.
 *
 * `userId` is the empty string rather than null: the policies normalise it
 * with `nullif(..., '')`, so the `user_id = ...` branches match nothing, which
 * is the right semantics for a credential with no person behind it. The
 * consequence is deliberate and already documented — audit logging cannot
 * attribute an API-key action to a person, which is precisely why it is a
 * break-glass credential.
 */
export function orgContextFor(_req: Request): OrgContext {
  return { organizationId: API_KEY_ORGANIZATION_ID, userId: "" };
}
