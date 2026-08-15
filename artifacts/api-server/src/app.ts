import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { csrfFetchMetadata, requireAuth } from "./lib/auth";
import { createSessionMiddleware } from "./lib/auth/session";
import { resolvePrincipal } from "./lib/principal";
import { enforceRole } from "./lib/require-role";
import { configureTrustProxy, edgeRateLimit, perRouteRateLimit } from "./lib/rate-limit";

const app: Express = express();

// Must run before any limiter is exercised: it decides what `req.ip` is, and
// therefore whether IP-keyed buckets mean anything behind a proxy.
configureTrustProxy(app);

/**
 * Explicit CORS origin allowlist — closes S4. `origin: true` reflected any
 * requesting origin, which must never ship alongside `credentials: true`.
 *
 * Set CORS_ALLOWED_ORIGINS to a comma-separated list of origins that may call
 * the API cross-origin (the deployed frontend). Same-origin requests are
 * unaffected by CORS and need no entry.
 */
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter((origin) => origin.length > 0);

if (allowedOrigins.length === 0) {
  logger.warn(
    "CORS_ALLOWED_ORIGINS is not set; cross-origin browser requests will be refused",
  );
}

const corsOptions: CorsOptions = {
  credentials: true,
  origin(origin, callback) {
    // Requests without an Origin header (curl, server-to-server) are not
    // subject to CORS; the API key is what protects those.
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, allowedOrigins.includes(origin.replace(/\/+$/, "")));
  },
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
};

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// cors() must stay ahead of requireAuth so OPTIONS preflight terminates here
// rather than being rejected with a 401.
app.use(cors(corsOptions));

// S6, layer 1: IP-keyed and *before* the auth middleware, because the 401 path
// is itself reachable without a key and would otherwise be free to hammer.
app.use("/api", edgeRateLimit);

/**
 * Sessions, when the deployment has configured them.
 *
 * Mounted **after** `edgeRateLimit` rather than where §6.1's diagram puts it.
 * That diagram predates the limiter: with the session ahead of it, an
 * anonymous flood drives a session-store read per request before the 429 is
 * ever reached, which turns the cheapest possible rejection into a database
 * round trip.
 *
 * `null` when `SESSION_SECRET` is unset — no cookie is parsed and no session
 * row is written, so a key-only deployment behaves exactly as it did.
 */
const sessionMiddleware = createSessionMiddleware();
if (sessionMiddleware) {
  app.use("/api", sessionMiddleware);
}

// Decide who the caller is, once, before anything asks. This is the only place
// a request's organisation is resolved — see lib/principal.ts.
app.use("/api", resolvePrincipal);

// Authenticate before the body parsers, so an unauthenticated request is
// rejected without first buffering and parsing up to 10 MB of JSON.
app.use("/api", requireAuth);

// RBAC stage 3 — one gate for every route, mounted after authentication has
// established who the caller is. Reads need `viewer`, writes need `member`, and
// anything needing more is named in `ROUTE_ROLE_OVERRIDES`. A route nobody
// thinks about is closed to viewers rather than open to them, which is the
// whole point of putting the default here — see lib/require-role.ts.
app.use("/api", enforceRole);

// CSRF (§3.9). Only bites a state-changing request that carries a session
// cookie: an API-key or anonymous caller has no ambient credential for a
// cross-site page to ride, and checking them would 403 every non-browser
// client of the public POST routes.
app.use("/api", csrfFetchMetadata(allowedOrigins));

// S6, layer 2: principal-keyed per-route budgets. After auth so it can key on
// the API key, still before the body parsers so an over-budget request is
// refused without buffering its payload.
app.use("/api", perRouteRateLimit);

// Per-route body ceilings, mounted ahead of the global 10 MB parser. body-parser
// marks a request as parsed, so the global parser below is a no-op once one of
// these has run. `/scans` and `/github/scan-files` keep the 10 MB ceiling —
// they legitimately carry source — which is why S6's "body size limits tuned
// per route" is only partly done and is recorded that way in 08-security.md.
app.use("/api/chat", express.json({ limit: "256kb" }));
app.use("/api/github/fetch", express.json({ limit: "8kb" }));
app.use("/api/github/scan", express.json({ limit: "8kb" }));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use("/api", router);

export default app;
