import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { rateLimit, ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { presentedKey } from "./auth";
import { logger } from "./logger";

/**
 * Rate limiting — S6.
 *
 * There was none, anywhere. A scan fans out to the GitHub API on a shared
 * token whose unauthenticated ceiling is 60 requests/hour, so a handful of
 * requests could take the feature down for every caller at once; `/chat`
 * proxies to an LLM and bills per token.
 *
 * ## What the limit is keyed on, and why
 *
 * **Per API key.** That is the honest unit today because the shared key is the
 * only principal the server has — there is no sign-in, no session, and no
 * person behind a request (see `lib/principal.ts` and
 * docs/Claude/13-auth-and-tenancy.md §6.1). Keying on the organisation would
 * be the same bucket by construction, since one key maps to one
 * `QUANTAXSCAN_API_KEY_ORG_ID`, and claiming "per-org limits" would overstate
 * it. **When F1 lands, the per-route buckets should key on the user id and
 * fall back to the key**, so one person cannot spend a whole organisation's
 * budget; that is a one-line change in {@link principalKey} plus a per-org
 * ceiling above it.
 *
 * Public routes carry no key, so those fall back to the client IP. IP is a
 * weak identifier — shared NAT collapses many callers into one bucket and a
 * distributed caller escapes it — which is exactly why the public budgets are
 * the generous ones and the expensive routes all sit behind the key.
 *
 * ## Two layers, and why the split matters
 *
 * `requireApiKey` runs before the body parsers, so the 401 path is itself
 * reachable without a key and needs its own protection:
 *
 * 1. {@link edgeRateLimit} — IP-keyed, mounted **before** `requireApiKey`.
 *    Deliberately not keyed on the presented key: rotating a made-up key value
 *    would otherwise buy unlimited budget, and the existence of a bucket would
 *    be observable.
 * 2. {@link perRouteRateLimit} — principal-keyed, mounted **after**
 *    `requireApiKey`, dispatching to a per-route budget.
 *
 * Both layers answer with the identical status, body and headers, and neither
 * sets `WWW-Authenticate`. A 429 therefore says nothing about whether the
 * presented key was valid — an unauthenticated caller is 401'd by the auth
 * middleware before the second layer is reached, so the second layer never
 * observes an invalid key at all.
 *
 * ## What this is not
 *
 * The store is **in-process memory**. N replicas means N × every budget, and a
 * restart resets every counter. A shared store (Redis) is the honest fix and
 * is not built. The register's remedy is "rate limits + scan queue"; the queue
 * is **deliberately deferred** — it is an architectural change (a job table,
 * a worker, a polling or streaming status API, and a UI that can render a
 * pending scan) rather than a middleware, and it belongs with the request
 * handler rework in 04-architecture.md. Rate limits cap the damage; they do
 * not stop a scan from occupying a request handler for its whole duration.
 * S6 stays unticked for both reasons.
 */

/** `[windowMs, max]`, read once at startup so a budget cannot drift per request. */
function budget(envVar: string, defaultMax: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === "") return defaultMax;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envVar} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

const MINUTE = 60_000;

/**
 * Budgets are env-overridable numbers rather than an on/off switch, so tests
 * can shrink a bucket without the codebase shipping a "disable rate limiting"
 * flag that a misconfigured deployment could trip.
 */
export const BUDGETS = {
  /** Pre-auth, per IP. Sized to absorb a browser session, not a scraper. */
  edge: { windowMs: 5 * MINUTE, max: budget("RATE_LIMIT_EDGE_MAX", 300) },
  /** Anything not named below. Cheap reads and small writes. */
  default: { windowMs: 5 * MINUTE, max: budget("RATE_LIMIT_DEFAULT_MAX", 120) },
  /**
   * Routes that call the GitHub API. One `/github/fetch` costs a tree call, two
   * branch probes and up to 25 raw file requests, so at the unauthenticated
   * ceiling of 60 requests/hour a single caller can exhaust the shared token in
   * well under ten scans. 12/hour per principal keeps one caller from doing it.
   */
  githubRemote: { windowMs: 60 * MINUTE, max: budget("RATE_LIMIT_GITHUB_MAX", 12) },
  /** CPU-bound: regex over every line of up to a 10 MB body. No network cost. */
  scan: { windowMs: 5 * MINUTE, max: budget("RATE_LIMIT_SCAN_MAX", 30) },
  /**
   * B3's TLS prober: real outbound `node:tls` connections to caller-named
   * hosts, up to `MAX_TLS_TARGETS_PER_SUBMISSION` per call. Egress this
   * server does not control is closer in kind to `githubRemote` than to the
   * local-CPU `scan` budget, so it gets its own, tighter allowance rather
   * than sharing either.
   */
  tls: { windowMs: 5 * MINUTE, max: budget("RATE_LIMIT_TLS_MAX", 15) },
  /** Billed per token by a third party, and streams for as long as it runs. */
  chat: { windowMs: 60 * MINUTE, max: budget("RATE_LIMIT_CHAT_MAX", 30) },
} as const;

/**
 * `GET /healthz` is exempt from the per-route layer entirely — a load balancer
 * probing it every second must not consume a scan's budget, which is the whole
 * point of not giving a health check and a scan the same limit. It is still
 * subject to the pre-auth edge limiter.
 */
const EXEMPT: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/healthz$/ },
];

/** Digest of the presented key, so no key material reaches a bucket name or a log. */
function keyDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/**
 * The bucket a request is charged to.
 *
 * `ipKeyGenerator` rather than a bare `req.ip`: it masks an IPv6 address to
 * its /56, so a caller with a routed prefix cannot get a fresh bucket per
 * address. Express's `trust proxy` decides what `req.ip` is — see
 * {@link configureTrustProxy}.
 */
export function principalKey(req: Request): string {
  const key = presentedKey(req.headers);
  if (key) return `key:${keyDigest(key)}`;
  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

function ipOnlyKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/**
 * The one 429 in the codebase. Identical at both layers, and deliberately
 * free of any hint about authentication: no `WWW-Authenticate`, no mention of
 * a key, no distinct message per bucket.
 */
function tooManyRequests(req: Request, res: Response): void {
  // express-rate-limit attaches `req.rateLimit` at runtime but does not augment
  // Express's `Request` type, so this is read through a narrow cast rather than
  // by widening the global type for every route.
  const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(((resetTime?.getTime() ?? Date.now()) - Date.now()) / 1000),
  );
  res.setHeader("Retry-After", String(retryAfterSeconds));
  logger.warn(
    { method: req.method, path: req.path, retryAfterSeconds },
    "Rate limited",
  );
  res.status(429).json({ error: "Too many requests" });
}

function limiter(
  { windowMs, max }: { windowMs: number; max: number },
  keyGenerator: (req: Request) => string,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit: max,
    keyGenerator,
    handler: tooManyRequests,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // Preflight never reaches a handler and must not be charged; the CORS
    // middleware answers it before this runs, but the guard is free.
    skip: (req) => req.method === "OPTIONS",
  });
}

/**
 * IP-keyed limiter for everything under `/api`, mounted before the API-key
 * middleware so that unauthenticated requests — including the ones that will
 * be rejected with a 401 — are bounded.
 */
export const edgeRateLimit: RequestHandler = limiter(BUDGETS.edge, ipOnlyKey);

const defaultLimiter = limiter(BUDGETS.default, principalKey);
const githubRemoteLimiter = limiter(BUDGETS.githubRemote, principalKey);
const scanLimiter = limiter(BUDGETS.scan, principalKey);
const chatLimiter = limiter(BUDGETS.chat, principalKey);
const tlsLimiter = limiter(BUDGETS.tls, principalKey);

/**
 * Per-route budgets. Paths are **mount-relative** — the router is mounted at
 * `/api`, so `POST /api/scans` is matched here as `/scans`, the same
 * convention as `PUBLIC_ROUTES` in `auth.ts`.
 *
 * First match wins; anything unmatched gets {@link defaultLimiter}.
 */
const ROUTE_BUDGETS: ReadonlyArray<{
  method: string;
  path: RegExp;
  limiter: RateLimitRequestHandler;
}> = [
  // Reaches out to api.github.com and raw.githubusercontent.com on a shared
  // token. The scarcest resource the server has.
  { method: "POST", path: /^\/github\/scan$/, limiter: githubRemoteLimiter },
  { method: "POST", path: /^\/github\/fetch$/, limiter: githubRemoteLimiter },
  // Deliberately *not* on the GitHub budget: `GET /rate_limit` is the one
  // GitHub endpoint that does not count against the core quota, so charging it
  // to the scarce bucket would ration a call that costs nothing.

  // Local CPU only — no GitHub quota — so a looser budget than the above.
  { method: "POST", path: /^\/github\/scan-files$/, limiter: scanLimiter },
  { method: "POST", path: /^\/scans$/, limiter: scanLimiter },
  { method: "POST", path: /^\/scans\/multi$/, limiter: scanLimiter },
  // Real outbound connections to caller-named hosts — see BUDGETS.tls.
  { method: "POST", path: /^\/projects\/[^/]+\/tls$/, limiter: tlsLimiter },
  // Public: scans a hard-coded repository from memory, but still runs the full
  // regex pass, and no key is required so this is IP-keyed in practice.
  { method: "POST", path: /^\/demo\/repos\/[^/]+\/scan$/, limiter: scanLimiter },

  { method: "POST", path: /^\/chat$/, limiter: chatLimiter },
];

function limiterFor(method: string, path: string): RateLimitRequestHandler | null {
  if (EXEMPT.some((route) => route.method === method && route.path.test(path))) {
    return null;
  }
  const match = ROUTE_BUDGETS.find(
    (route) => route.method === method && route.path.test(path),
  );
  return match ? match.limiter : defaultLimiter;
}

/**
 * Principal-keyed limiter, mounted on `/api` **after** `requireApiKey`.
 * Dispatches to the budget for the matched route, or the default.
 */
export const perRouteRateLimit: RequestHandler = (req, res, next) => {
  const chosen = limiterFor(req.method, req.path);
  if (!chosen) {
    next();
    return;
  }
  chosen(req, res, next);
};

/**
 * Applies `TRUST_PROXY` if it is set.
 *
 * This matters more than it looks. Behind a reverse proxy with `trust proxy`
 * unset, `req.ip` is the proxy's address for every request, so every
 * IP-keyed bucket collapses into one and the public routes rate-limit the
 * whole world together. Set it wrong in the other direction and a client can
 * forge `X-Forwarded-For` and mint a fresh bucket per request.
 *
 * The safe value is the **number of proxies** in front of this server (`1` for
 * a single load balancer), which makes Express read the correct hop and ignore
 * anything the client appended. A bare `true` trusts every hop and is
 * rejected here rather than passed through.
 */
export function configureTrustProxy(app: {
  set: (setting: string, value: unknown) => void;
}): void {
  const raw = process.env["TRUST_PROXY"];
  if (raw === undefined || raw.trim() === "") {
    // warn, not info: behind a proxy this is a self-inflicted outage on the one
    // journey that still works without an API key (the public demo scan), and
    // the symptom — everyone sharing one bucket — looks like a load problem
    // rather than a configuration one.
    logger.warn(
      "TRUST_PROXY is not set; rate limiting keys on the socket address. Behind a reverse proxy every caller shares one bucket and the public routes rate-limit the world together — set it to the number of proxies in front of this server.",
    );
    return;
  }

  const trimmed = raw.trim();
  if (trimmed === "true") {
    throw new Error(
      'TRUST_PROXY="true" trusts every hop, which lets a client forge X-Forwarded-For and evade IP rate limiting. ' +
        "Set it to the number of proxies in front of this server (e.g. 1), or to a specific address/subnet.",
    );
  }

  const hops = Number(trimmed);
  app.set("trust proxy", Number.isInteger(hops) && hops > 0 ? hops : trimmed);
  logger.info({ trustProxy: trimmed }, "Trust proxy configured");
}
