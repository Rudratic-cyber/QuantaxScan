import type { Request, RequestHandler } from "express";
import type { OrgContext } from "@workspace/db/org-scope";
import { CONFIGURED_KEY_COUNT, matchedKeyIndex, presentedKey } from "./auth";
// Imported lazily at the one call site below, not here. `./auth/identity`
// reaches `@workspace/db`, which builds its pool at import time and throws
// without `DATABASE_URL` — so a static import would make merely *loading*
// `principal.ts` require a database. That is a real coupling (this module is on
// the request path for every route, and its key-to-organisation binding is pure
// env parsing) and `principal.test.ts` is built on the property, stating in its
// header that it needs "no database, no HTTP". The dynamic import costs one
// already-resolved module lookup on the session path only.
import type { Principal } from "./auth/types";
import { ABSOLUTE_SESSION_LIFETIME_MS } from "./auth/session";
import { logger } from "./logger";

/**
 * Which organisation a request acts as — the single place that decides it.
 *
 * There are two *kinds* of authenticated principal:
 *
 * **The shared API key.** A **break-glass and machine credential** — CI, the
 * backfill scripts, any server-to-server caller — not the user path. Each
 * configured key is bound to an organisation, so N keys serve N organisations
 * from one deployment rather than one key reading everything.
 *
 * **A signed-in person.** Resolved from the session cookie, and only after
 * re-reading `organization_members`. Added by F1; the API-key path below is
 * unchanged by it, deliberately and to the letter — it is what every existing
 * test and the whole end-to-end suite authenticate with, and what the live
 * deployment runs on.
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
 * The API-key principal for a request, or null if none was presented or the
 * presented one is not configured.
 *
 * `userId` is the empty string rather than null: the policies normalise it
 * with `nullif(..., '')`, so the `user_id = ...` branches match nothing, which
 * is the right semantics for a credential with no person behind it. The
 * consequence is deliberate and already documented — audit logging cannot
 * attribute an API-key action to a person, which is precisely why it is a
 * break-glass credential.
 */
function apiKeyPrincipal(req: Request): Principal | null {
  const presented = presentedKey(req.headers);
  if (!presented) return null;
  const index = matchedKeyIndex(presented);
  if (index === null) return null;
  return { kind: "apiKey", organizationId: API_KEY_ORG_IDS[index], userId: "" };
}

/**
 * Resolve the request's principal exactly once, before any route runs.
 *
 * **This is the function a bug in returns another tenant's data rather than an
 * error**, so three properties are load-bearing:
 *
 *   1. **The API key wins, and its branch is untouched.** A request carrying a
 *      recognised key resolves exactly as it did before sessions existed. A
 *      request carrying an *unrecognised* key resolves to no principal and is
 *      401'd — it does NOT fall through to the cookie, because a caller who
 *      meant to authenticate as a machine must not silently act as whichever
 *      person happens to share the browser.
 *
 *   2. **Membership is re-read from the database, every request.** Not from
 *      the session, which is a cache. This is what makes revoking a member
 *      take effect on their next request rather than up to seven days later
 *      when the cookie finally expires (§6.3).
 *
 *   3. **A user with no membership gets `organizationId: null`, never a
 *      default.** `orgContextFor` then refuses. Substituting organisation 1
 *      for "we could not work out which organisation" is the cross-tenant
 *      read this whole mechanism exists to prevent, and it is the shape the
 *      mistake takes.
 */
export const resolvePrincipal: RequestHandler = (req, res, next) => {
  const byKey = apiKeyPrincipal(req);
  if (byKey) {
    req.principal = byKey;
    next();
    return;
  }

  const session = req.session;
  const userId = session?.userId;
  if (!session || !userId) {
    req.principal = { kind: "anonymous" };
    next();
    return;
  }

  // `rolling` re-sets the cookie on every response, so idle timeout alone can
  // never end a session that is being used. The absolute cap is what does.
  if (session.absoluteExpiresAt !== undefined && session.absoluteExpiresAt <= Date.now()) {
    req.principal = { kind: "anonymous" };
    session.destroy(() => next());
    return;
  }

  import("./auth/identity")
    .then(async ({ membershipsFor, pickActiveOrganization }) => {
      const memberships = await membershipsFor(userId);
      const active = pickActiveOrganization(memberships, session.organizationId);
      // Write the resolved organisation back so the switcher's choice survives
      // the next request. It is only ever *read* through the membership list
      // above, so a stale value cannot grant anything.
      session.organizationId = active?.organizationId;
      req.principal = {
        kind: "session",
        userId,
        organizationId: active?.organizationId ?? null,
        role: active?.role ?? null,
        memberships,
      };
      next();
    })
    .catch((err: unknown) => {
      logger.error({ err }, "failed to resolve session principal");
      // Fail closed. A membership read that errored is not evidence of access.
      req.principal = { kind: "anonymous" };
      next();
    });
};

/**
 * The organisation context for an authenticated request.
 *
 * Synchronous and pure over `req.principal` on purpose: every database read
 * that decides the answer happened in `resolvePrincipal`, before any route ran.
 * An `await` here would sit inside whatever scope the caller is about to open,
 * which is how a nested scope — the one failure that returns another tenant's
 * rows rather than none — gets introduced.
 *
 * Throwing is correct for the API-key and anonymous cases: `requireAuth` has
 * already rejected them, so reaching the throw means a route called this
 * outside that guarantee, which is a bug in the route rather than a reachable
 * runtime state. The signed-in-but-organisation-less case is different — it IS
 * reachable, by revoking a member's last membership — so it gets its own error
 * and `requireAuth` answers it with a 403 before a handler ever asks.
 */
export function orgContextFor(req: Request): OrgContext {
  const principal = req.principal;

  if (!principal || principal.kind === "anonymous") {
    throw new Error(
      "orgContextFor called without an authenticated principal — requireAuth should have rejected this request already",
    );
  }

  if (principal.kind === "apiKey") {
    return { organizationId: principal.organizationId, userId: principal.userId };
  }

  if (principal.organizationId === null) {
    throw new Error(
      "orgContextFor called for a signed-in user who belongs to no organisation. There is no default " +
        "to fall back to — that would be a cross-tenant read. requireAuth answers this with a 403.",
    );
  }

  return { organizationId: principal.organizationId, userId: principal.userId };
}
