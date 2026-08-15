import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { logger } from "./logger";
// Side-effect import: brings `req.principal` and the session payload's shape
// into scope. Without it both read as `any`/absent here.
import "./auth/types";

/**
 * API authentication — the default-deny gate and the key half of the two
 * principals behind it.
 *
 * Every route under `/api` requires a principal unless it appears in
 * PUBLIC_ROUTES below. `resolvePrincipal` (`lib/principal.ts`) decides which
 * one; this file decides whether "none" is acceptable for the route.
 *
 * The shared API key remains exactly what it was — a break-glass and machine
 * credential, matched here by constant-time digest comparison. F1 added a
 * second principal (a signed-in person) *beside* it, changing none of the
 * behaviour below: the same headers, the same 401, the same
 * `WWW-Authenticate`.
 *
 * See docs/Claude/08-security.md (S1), docs/Claude/09-open-gaps.md (G-12), and
 * docs/Claude/13-auth-and-tenancy.md §6.1–6.2.
 */

const ENV_VAR = "QUANTAXSCAN_API_KEYS";

/** Configured keys shorter than this are rejected at startup. */
const MIN_KEY_LENGTH = 24;

/**
 * Routes that are public by design. Paths are **mount-relative**: the router is
 * mounted at `/api`, so `GET /api/healthz` is matched here as `/healthz`.
 *
 * Nothing that reads or writes real project, scan, or finding data belongs in
 * this table. Demo routes serve hard-coded repositories; community posts are
 * user-submitted public content.
 *
 * Exported so `openapi-drift.test.ts` can assert that this table and the
 * `security: []` overrides in `lib/api-spec/openapi.yaml` say the same thing.
 * A spec that documents a protected route as public is a security-relevant
 * error, not a cosmetic one — the generated client is what a consumer reads
 * when deciding whether to send a key.
 */
export const PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/healthz$/ },
  { method: "GET", path: /^\/demo\/repos$/ },
  { method: "POST", path: /^\/demo\/repos\/[^/]+\/scan$/ },
  { method: "GET", path: /^\/community\/posts$/ },
  { method: "GET", path: /^\/community\/leaderboard$/ },
  // Share links are public-by-link by design. The ID is the only control, so it
  // must stay cryptographically random — see generateId() in routes/reports.ts.
  { method: "GET", path: /^\/reports\/[^/]+$/ },
  // F1 — the sign-in routes. Every one of these is how a caller *becomes*
  // authenticated, so requiring authentication to reach them would be a
  // deadlock. `:provider` matches any segment here and is validated in the
  // handler, which 404s an unknown or unconfigured one.
  { method: "GET", path: /^\/auth\/providers$/ },
  { method: "GET", path: /^\/auth\/[^/]+\/start$/ },
  { method: "GET", path: /^\/auth\/[^/]+\/callback$/ },
  // Called on every page load, including for visitors who have never signed
  // in. It answers 200 with `{ user: null }` rather than 401 — an anonymous
  // visitor is a normal state, and a 401 here would be indistinguishable from
  // a real failure.
  { method: "GET", path: /^\/auth\/session$/ },
  // Idempotent, and public so that signing out of an already-expired session
  // succeeds rather than 401ing the one action that is supposed to end it.
  { method: "POST", path: /^\/auth\/logout$/ },
];

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function parseKeys(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

const configuredKeys = parseKeys(process.env[ENV_VAR]);

/** SHA-256 digests of the configured keys, so comparison is fixed-length. */
const keyDigests: Buffer[] = configuredKeys.map(sha256);

/**
 * Throws unless usable API keys are configured. Called at startup so that a
 * deployment missing the secret fails loudly instead of serving an open API.
 */
export function assertApiKeysConfigured(): void {
  if (configuredKeys.length === 0) {
    throw new Error(
      `${ENV_VAR} environment variable is required but was not provided. ` +
        `Set it to one or more comma-separated API keys, e.g. ` +
        `${ENV_VAR}="$(openssl rand -base64 32)". Refusing to start with an unauthenticated API.`,
    );
  }

  const tooShort = configuredKeys.filter((key) => key.length < MIN_KEY_LENGTH);
  if (tooShort.length > 0) {
    throw new Error(
      `${ENV_VAR} contains ${tooShort.length} key(s) shorter than ${MIN_KEY_LENGTH} characters. ` +
        `Use high-entropy keys, e.g. "$(openssl rand -base64 32)".`,
    );
  }
}

function isPublic(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => route.method === method && route.path.test(path),
  );
}

/**
 * Extracts the presented key from `Authorization: Bearer <key>` or `X-API-Key`.
 *
 * Exported for the rate limiter, which keys its per-principal buckets on the
 * digest of this value. It must never be logged or returned.
 */
export function presentedKey(headers: {
  authorization?: string;
  "x-api-key"?: string | string[];
}): string | null {
  const authorization = headers.authorization;
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }

  const apiKey = headers["x-api-key"];
  const value = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  return value?.trim() || null;
}

/** How many keys are configured. Exported so a binding built elsewhere (one
 * entry per key, e.g. `principal.ts`'s organisation map) can validate its own
 * length against this without re-parsing the environment variable itself. */
export const CONFIGURED_KEY_COUNT = configuredKeys.length;

/**
 * The index into the configured key list of the key that matches `presented`,
 * or `null` if none does. Never returns the key itself — callers get a
 * position, not the secret.
 *
 * Loops over every configured digest regardless of an earlier match, for the
 * same reason `isValidKey` below does: once more than one key is configured,
 * *which* key matched is exactly the information a timing side-channel would
 * leak if the loop stopped early.
 */
export function matchedKeyIndex(presented: string): number | null {
  const presentedDigest = sha256(presented);
  // Digests are always 32 bytes, so timingSafeEqual cannot throw on a length
  // mismatch the way it would when comparing the raw keys.
  let matched: number | null = null;
  keyDigests.forEach((digest, index) => {
    if (timingSafeEqual(presentedDigest, digest)) matched = index;
  });
  return matched;
}

/**
 * Default-deny authentication middleware. Mount it on the `/api` router
 * *after* `cors()`, so that OPTIONS preflight requests terminate in the CORS
 * handler and are never rejected with a 401, and after `resolvePrincipal`,
 * which is what decides who the caller is.
 *
 * Two rejections, and they are different states:
 *
 *   * **401** — no principal at all. Identical in status, body and
 *     `WWW-Authenticate` header to what shipped before sessions existed, so a
 *     key-only caller cannot tell this middleware changed.
 *   * **403** — a signed-in person who belongs to no organisation. They are
 *     authenticated; there is simply nothing for them to act in. Answering 401
 *     would tell them to sign in again, which would not help, and falling back
 *     to some default organisation would be the cross-tenant read this whole
 *     mechanism exists to prevent.
 */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (isPublic(req.method, req.path)) {
    next();
    return;
  }

  if (keyDigests.length === 0) {
    // Should be unreachable — assertApiKeysConfigured() runs at startup — but
    // fail closed rather than fall through to the route if it ever is.
    logger.error({ envVar: ENV_VAR }, "No API keys configured; denying request");
    res.status(503).json({ error: "Service misconfigured" });
    return;
  }

  const principal = req.principal;

  if (!principal || principal.kind === "anonymous") {
    const presented = presentedKey(req.headers);
    logger.warn(
      { method: req.method, path: req.path, presented: presented ? "invalid" : "absent" },
      "Rejected unauthenticated API request",
    );
    res.setHeader("WWW-Authenticate", 'Bearer realm="quantaxscan-api"');
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (principal.kind === "session" && principal.organizationId === null) {
    res.status(403).json({ error: "No organisation" });
    return;
  }

  next();
};

/**
 * CSRF — docs/Claude/13-auth-and-tenancy.md §3.9, layer 2.
 *
 * `SameSite=Lax` is necessary and not sufficient: it permits top-level GET
 * navigations, and it is a browser-side control a server should not rely on
 * alone. So every state-changing method is additionally checked against the
 * Fetch-metadata headers the browser sets and a page cannot forge.
 *
 * **The check applies only to a request carrying a session cookie.** That is
 * narrower than §3.9's "every state-changing method", and deliberately:
 *
 *   * §3.9 already exempts API-key requests — they are not browser-driven and
 *     carry no ambient credential.
 *   * A request with no session cookie carries no ambient credential either,
 *     so there is nothing for a cross-site page to ride. Checking it anyway
 *     would 403 the genuinely public writes (`POST /demo/repos/:slug/scan`,
 *     `POST /community/posts`) for every non-browser caller — curl, CI, the
 *     e2e suite — which sends neither header. That is a behaviour change with
 *     no security gain, and this lane's rule is that the pre-session paths
 *     behave exactly as they did.
 *
 * Per the Fetch standard the browser sets `Origin` on every non-`GET`/`HEAD`
 * request, so a legitimate browser call always presents one of the two signals.
 */
export function csrfFetchMetadata(allowedOrigins: readonly string[]): RequestHandler {
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

  return (req, res, next) => {
    if (safeMethods.has(req.method)) {
      next();
      return;
    }
    // No session on the request means no ambient credential to abuse.
    if (!req.session?.userId) {
      next();
      return;
    }
    if (req.principal?.kind === "apiKey") {
      next();
      return;
    }

    const site = req.get("sec-fetch-site");
    if (site === "same-origin" || site === "none") {
      next();
      return;
    }

    const origin = req.get("origin");
    if (origin && allowedOrigins.includes(origin.replace(/\/+$/, ""))) {
      next();
      return;
    }

    logger.warn(
      { method: req.method, path: req.path, site: site ?? "absent", origin: origin ?? "absent" },
      "Rejected cross-site state-changing request from a session-authenticated caller",
    );
    res.status(403).json({ error: "Cross-site request refused" });
  };
}
