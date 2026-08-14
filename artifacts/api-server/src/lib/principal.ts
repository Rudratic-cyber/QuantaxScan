import type { Request } from "express";
import type { OrgContext } from "@workspace/db/org-scope";
import { CONFIGURED_KEY_COUNT, matchedKeyIndex, presentedKey } from "./auth";
import { logger } from "./logger";

/**
 * Which organisation a request acts as.
 *
 * Today there is exactly one *kind* of authenticated principal: the shared
 * API key. It is a **break-glass and machine credential** — CI, the backfill
 * scripts, any server-to-server caller — not the user path. What this module
 * does is bind each configured key to an organisation, so N keys can serve N
 * organisations from one deployment rather than one key reading everything.
 *
 * The binding is positional: `QUANTAXSCAN_API_KEY_ORG_IDS` is split the same
 * way `QUANTAXSCAN_API_KEYS` is in `auth.ts` (comma-separated, trimmed, empty
 * entries dropped), and entry *i* of one is the organisation for entry *i* of
 * the other. That is deliberately explicit rather than convenient — a shorter
 * or longer list is a startup error (see `buildOrgIdsByKeyIndex`), not a
 * guess. The alternative (any key not listed defaults to organisation 1)
 * would mean a typo'd or forgotten binding silently reads and writes the
 * captain's data instead of failing to start.
 *
 * `QUANTAXSCAN_API_KEY_ORG_IDS` unset entirely means every configured key
 * binds to the single legacy `QUANTAXSCAN_API_KEY_ORG_ID` (default
 * organisation 1) — the exact pre-existing behaviour, preserved so a
 * single-organisation deployment needs no change to keep working.
 *
 * When per-user sign-in lands this grows into `resolvePrincipal`, returning
 * one of session / apiKey / anonymous. Deliberately not built here — a
 * session with no way to sign in is not worth the surface.
 *
 * See docs/Claude/13-auth-and-tenancy.md §6.1.
 */

const KEYS_ENV_VAR = "QUANTAXSCAN_API_KEYS";
const ORG_IDS_ENV_VAR = "QUANTAXSCAN_API_KEY_ORG_IDS";
const LEGACY_ORG_ID_ENV_VAR = "QUANTAXSCAN_API_KEY_ORG_ID";
const DEFAULT_ORGANIZATION_ID = 1;

function parsePositiveInt(raw: string, envVar: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envVar} must contain only positive integer organisation ids, got "${raw}".`);
  }
  return parsed;
}

/** `undefined`/blank → `null`, which is the signal to fall back to the legacy binding. */
function parseExplicitOrgIds(raw: string | undefined): number[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => parsePositiveInt(value, ORG_IDS_ENV_VAR));
}

function parseLegacyOrgId(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ORGANIZATION_ID;
  return parsePositiveInt(raw.trim(), LEGACY_ORG_ID_ENV_VAR);
}

/**
 * One organisation id per configured API key, in the same order
 * `QUANTAXSCAN_API_KEYS` is split in `auth.ts`. Built once at import time so a
 * misconfigured binding is a boot-time failure, not a per-request surprise —
 * consistent with `assertApiKeysConfigured()` failing the same way one file
 * over.
 */
function buildOrgIdsByKeyIndex(): readonly number[] {
  const explicit = parseExplicitOrgIds(process.env[ORG_IDS_ENV_VAR]);
  if (explicit !== null) {
    if (explicit.length !== CONFIGURED_KEY_COUNT) {
      throw new Error(
        `${ORG_IDS_ENV_VAR} lists ${explicit.length} organisation id(s) but ${KEYS_ENV_VAR} configures ` +
          `${CONFIGURED_KEY_COUNT} key(s). They must be the same length and in the same order — one ` +
          `organisation id per key, positionally. Refusing to start rather than let an unlisted key ` +
          `default to organisation ${DEFAULT_ORGANIZATION_ID} silently.`,
      );
    }
    return explicit;
  }
  // No explicit binding: every configured key shares the one legacy id. This
  // is exactly today's behaviour for a single key, and — deliberately — the
  // same fixed id for every key if more than one is configured without also
  // setting QUANTAXSCAN_API_KEY_ORG_IDS. That is not a footgun: it means
  // "several keys, one organisation", which is a legitimate shape (e.g. one
  // key for the browser build, one for CI), not several tenants sharing data
  // by accident.
  return new Array(CONFIGURED_KEY_COUNT).fill(parseLegacyOrgId(process.env[LEGACY_ORG_ID_ENV_VAR]));
}

/** Organisation id for the key at each index. Read-only after startup. */
export const API_KEY_ORG_IDS: readonly number[] = buildOrgIdsByKeyIndex();

{
  const distinct = new Set(API_KEY_ORG_IDS);
  if (distinct.size > 1) {
    logger.info(
      { organizationIds: [...distinct].sort((a, b) => a - b) },
      "API keys are bound to more than one organisation",
    );
  } else if (distinct.size === 1 && !distinct.has(DEFAULT_ORGANIZATION_ID)) {
    logger.info({ organizationId: [...distinct][0] }, "Shared API key is bound to a non-default organisation");
  }
}

/**
 * The organisation context for an authenticated request.
 *
 * Resolved from *which* configured key was presented, not from a single
 * fixed value — this is what makes N keys able to reach N different
 * organisations. `requireApiKey` (`auth.ts`) has already rejected anything
 * that is not a recognised key before any route handler, and therefore this
 * function, runs; reaching the `throw` below means a route called it outside
 * that guarantee, which is a bug in the route, not a reachable runtime state.
 *
 * `userId` is the empty string rather than null: the policies normalise it
 * with `nullif(..., '')`, so the `user_id = ...` branches match nothing, which
 * is the right semantics for a credential with no person behind it. The
 * consequence is deliberate and already documented — audit logging cannot
 * attribute an API-key action to a person, which is precisely why it is a
 * break-glass credential.
 */
export function orgContextFor(req: Request): OrgContext {
  const presented = presentedKey(req.headers);
  const index = presented ? matchedKeyIndex(presented) : null;

  if (index === null) {
    throw new Error(
      "orgContextFor called without a matched API key principal — requireApiKey should have rejected this request already",
    );
  }

  return { organizationId: API_KEY_ORG_IDS[index], userId: "" };
}
