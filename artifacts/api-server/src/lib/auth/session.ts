import { sql } from "drizzle-orm";
import session, { Store, type SessionData, type SessionOptions } from "express-session";
import type { RequestHandler } from "express";
import { withoutOrgScope } from "@workspace/db";
import { executeRows } from "@workspace/db/org-scope";
import { logger } from "../logger";

/**
 * Sessions — docs/Claude/13-auth-and-tenancy.md §3.8.
 *
 * ## Why the store is written here rather than taken from `connect-pg-simple`
 *
 * §3.2 specifies `connect-pg-simple@10`. It is not used, and the reason is not
 * preference. `connect-pg-simple` takes its own `pg.Pool` (or opens one from
 * `DATABASE_URL`) and speaks raw SQL to it — a second connection, outside the
 * `@workspace/db` handle everything else in this process uses. Two
 * consequences, and the second is the one that decided it:
 *
 *   1. It cannot run against PGlite. The API test suite mocks `@workspace/db`
 *      with a pglite-backed handle and `pool: {}`, so a `connect-pg-simple`
 *      store would either talk to a database that is not the test's or fail
 *      outright. The **session half of the cross-tenant suite** — two
 *      signed-in users, membership revocation taking effect on the next
 *      request — could therefore not exist at all, and that suite is the
 *      entire point of this work.
 *   2. Its writes would sit outside the scope helpers, so nothing would report
 *      that a table was being reached unscoped.
 *
 * What replaces it is ~40 lines against the same `sessions` table
 * `connect-pg-simple`'s own `table.sql` defines (that shape is already in
 * `lib/db/src/schema/auth.ts`, near-verbatim), through
 * `withoutOrgScope("session store")`. `sessions` is deliberately not
 * RLS-scoped — it is read before anyone knows who the caller is — so the
 * escape hatch is the correct helper, and the reason is declared in
 * `UNSCOPED_BY_DESIGN` so it reports as routine rather than firing a
 * stack-carrying warning on every request.
 *
 * Everything `express-session` itself provides is kept: cookie signing,
 * `regenerate()` (the session-fixation defence), `rolling`, and secret
 * rotation via a secret array.
 *
 * ## Sign-in is opt-in, and absent means absent
 *
 * With no `SESSION_SECRET` there is no session middleware at all: no cookie is
 * parsed, no session row is written, and the API-key path is byte-for-byte
 * what it was. That is what lets this ship without changing the behaviour of
 * a deployment that has not configured sign-in — including every existing
 * test and the whole e2e suite. It is not a silent downgrade: configuring an
 * identity provider without a session secret is a startup error (see
 * `assertSessionConfigured`), because *that* combination is a sign-in flow
 * that would appear to work and quietly authenticate nobody.
 */

const SECRET_ENV_VAR = "SESSION_SECRET";

/** express-session's own guidance is ≥ 32 bytes; §3.8 pins it. */
const MIN_SECRET_LENGTH = 32;

/** 8 hours of inactivity, refreshed on every response by `rolling`. */
export const IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/**
 * 7 days from sign-in, regardless of activity. `rolling` alone extends a
 * session indefinitely, so the absolute cap is stored in the session payload
 * and enforced by `resolvePrincipal`, not by the cookie.
 */
export const ABSOLUTE_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function parseSecrets(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0);
}

const configuredSecrets = parseSecrets(process.env[SECRET_ENV_VAR]);

/** True when this process can hold sessions at all. */
export const SESSIONS_ENABLED = configuredSecrets.length > 0;

/**
 * `secure` decides two things at once, and getting it wrong is silent.
 *
 * §13.4: with `secure: true` and no `X-Forwarded-Proto: https`,
 * express-session emits **no `Set-Cookie` header whatsoever** — sign-in
 * redirects, appears to succeed, and the user is anonymous. And the `__Host-`
 * prefix is rejected by browsers without `Secure`, so the cookie name has to
 * follow the same switch.
 *
 * It defaults to on in production, which is right for the deployed
 * same-origin topology. `SESSION_COOKIE_SECURE=0` turns it off explicitly, and
 * exists for exactly one reason: the end-to-end suite runs the built server
 * with `NODE_ENV=production` over plain `http://`, where the default would
 * produce §13.4 and a spec that fails for a reason unrelated to what it tests.
 * It is opt-out and never inferred, so a real deployment cannot arrive at it
 * by accident.
 */
export function cookieIsSecure(): boolean {
  const override = process.env["SESSION_COOKIE_SECURE"];
  if (override !== undefined && override.trim() !== "") return override.trim() !== "0";
  return process.env["NODE_ENV"] === "production";
}

/**
 * `__Host-` makes the cookie un-settable by any sibling subdomain and
 * un-scopable by `Domain`, which removes the subdomain cookie-injection route
 * into the session. It requires `Secure`, `Path=/` and no `Domain` — all three
 * hold below.
 */
export function sessionCookieName(): string {
  return cookieIsSecure() ? "__Host-qx.sid" : "qx.sid";
}

/**
 * Fail closed at startup, in the shape `assertApiKeysConfigured()` already
 * uses one file over.
 *
 * Two failures, and the second is the one worth having: a *weak* secret is
 * rejected, and a configured identity provider with no secret at all is
 * rejected. The latter is the combination that would otherwise ship a sign-in
 * button leading to a flow that authenticates nobody.
 */
export function assertSessionConfigured(providersConfigured: boolean): void {
  const tooShort = configuredSecrets.filter((secret) => secret.length < MIN_SECRET_LENGTH);
  if (tooShort.length > 0) {
    throw new Error(
      `${SECRET_ENV_VAR} contains ${tooShort.length} secret(s) shorter than ${MIN_SECRET_LENGTH} characters. ` +
        `Use high-entropy values, e.g. "$(openssl rand -base64 48)". Refusing to start.`,
    );
  }

  if (providersConfigured && !SESSIONS_ENABLED) {
    throw new Error(
      `An identity provider is configured but ${SECRET_ENV_VAR} is not set. Sign-in cannot hold a ` +
        `session without it: the flow would complete, set nothing, and leave the caller anonymous. ` +
        `Set ${SECRET_ENV_VAR} (comma-separated for rotation; the first signs, all verify) or ` +
        `unconfigure the provider. Refusing to start.`,
    );
  }
}

interface SessionRow {
  sess: SessionData;
  expired: boolean;
}

/**
 * `express-session`'s `Store`, over the `sessions` table.
 *
 * Deliberately does not implement `all()`/`length()`/`clear()`: nothing in
 * this codebase enumerates sessions, and a store that can list every live
 * session is a capability worth not having.
 */
export class DrizzleSessionStore extends Store {
  get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    withoutOrgScope("session store", (tx) =>
      executeRows<SessionRow>(
        tx,
        // Expiry is decided in SQL, comparing two `timestamptz` values, for
        // the reason `sessions.expire` is `timestamptz` in the first place
        // (§2.3): a comparison that depends on the connection's `TimeZone`
        // expires sessions at the wrong moment. Reading the row and comparing
        // in JavaScript would reintroduce the same class of bug via the
        // driver's date parsing.
        sql`select sess, (expire <= now()) as expired from sessions where sid = ${sid}`,
      ),
    ).then(
      (rows) => {
        const row = rows[0];
        // An expired row resolves to "no session" rather than an error. It is
        // pruned lazily below rather than swept: there is no scheduler in this
        // process, and a row nobody can use is not a correctness problem.
        if (!row || row.expired) {
          if (row?.expired) this.destroy(sid, () => {});
          callback(null, null);
          return;
        }
        callback(null, row.sess);
      },
      (err) => callback(err),
    );
  }

  set(sid: string, sessionData: SessionData, callback?: (err?: unknown) => void): void {
    const expire = expiryOf(sessionData);
    withoutOrgScope("session store", (tx) =>
      tx.execute(
        sql`insert into sessions (sid, sess, expire) values (${sid}, ${JSON.stringify(sessionData)}::jsonb, ${expire})
              on conflict (sid) do update set sess = excluded.sess, expire = excluded.expire`,
      ),
    ).then(
      () => callback?.(),
      (err) => callback?.(err),
    );
  }

  /**
   * `resave: false` relies on this: without a `touch`, an idle-but-active
   * session's expiry would never move and `rolling` would be cosmetic.
   */
  touch(sid: string, sessionData: SessionData, callback?: () => void): void {
    const expire = expiryOf(sessionData);
    withoutOrgScope("session store", (tx) =>
      tx.execute(sql`update sessions set expire = ${expire} where sid = ${sid}`),
    ).then(
      () => callback?.(),
      (err) => {
        logger.warn({ err }, "session touch failed");
        callback?.();
      },
    );
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    withoutOrgScope("session store", (tx) =>
      tx.execute(sql`delete from sessions where sid = ${sid}`),
    ).then(
      () => callback?.(),
      (err) => callback?.(err),
    );
  }
}

function expiryOf(sessionData: SessionData): Date {
  const cookieExpiry = sessionData.cookie?.expires;
  if (cookieExpiry) return new Date(cookieExpiry);
  return new Date(Date.now() + IDLE_TIMEOUT_MS);
}

/**
 * The middleware, or `null` when no secret is configured.
 *
 * `null` rather than a no-op that sets `req.session = {}`: a request with no
 * session must be distinguishable from a request whose session is empty, and
 * `resolvePrincipal` reads exactly that difference.
 */
export function createSessionMiddleware(): RequestHandler | null {
  if (!SESSIONS_ENABLED) return null;

  const options: SessionOptions = {
    name: sessionCookieName(),
    store: new DrizzleSessionStore(),
    // express-session: "Only the first element will be used to sign ... while
    // all elements will be considered when verifying" — so a secret can be
    // rotated without signing everybody out.
    secret: configuredSecrets,
    resave: false,
    // Anonymous visitors create no session row. It is also what makes the
    // OAuth transaction write in `/start` the thing that creates the session.
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: cookieIsSecure(),
      // Correct for a same-origin deployment. Never "none" (a credential-theft
      // primitive alongside a reflected CORS origin) and never "auto", which
      // is documented as setting SameSite=None on secure connections.
      sameSite: "lax",
      path: "/",
      // No `domain`: required by the __Host- prefix.
      maxAge: IDLE_TIMEOUT_MS,
    },
  };

  return session(options);
}
