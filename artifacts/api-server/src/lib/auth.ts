import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { logger } from "./logger";

/**
 * Interim API authentication — closes S1 / G-12.
 *
 * Every route under `/api` requires a shared API key unless it appears in
 * PUBLIC_ROUTES below. This is deliberately *not* the F1 design: there is no
 * per-user identity and no organisation scoping, so it cannot enforce tenant
 * isolation. It exists to stop anonymous reads and deletes of production data
 * on the live deployment while F1 is built.
 *
 * See docs/Claude/08-security.md (S1) and docs/Claude/09-open-gaps.md (G-12).
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
 */
const PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/healthz$/ },
  { method: "GET", path: /^\/demo\/repos$/ },
  { method: "POST", path: /^\/demo\/repos\/[^/]+\/scan$/ },
  { method: "GET", path: /^\/community\/posts$/ },
  { method: "GET", path: /^\/community\/leaderboard$/ },
  // Share links are public-by-link by design. The ID is the only control, so it
  // must stay cryptographically random — see generateId() in routes/reports.ts.
  { method: "GET", path: /^\/reports\/[^/]+$/ },
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
 */
function presentedKey(headers: {
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

function isValidKey(presented: string): boolean {
  const presentedDigest = sha256(presented);
  // Digests are always 32 bytes, so timingSafeEqual cannot throw on a length
  // mismatch the way it would when comparing the raw keys.
  let matched = false;
  for (const digest of keyDigests) {
    if (timingSafeEqual(presentedDigest, digest)) matched = true;
  }
  return matched;
}

/**
 * Default-deny API key middleware. Mount it on the `/api` router *after*
 * `cors()`, so that OPTIONS preflight requests terminate in the CORS handler
 * and are never rejected with a 401.
 */
export const requireApiKey: RequestHandler = (req, res, next) => {
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

  const presented = presentedKey(req.headers);

  if (!presented || !isValidKey(presented)) {
    logger.warn(
      { method: req.method, path: req.path, presented: presented ? "invalid" : "absent" },
      "Rejected unauthenticated API request",
    );
    res.setHeader("WWW-Authenticate", 'Bearer realm="quantaxscan-api"');
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
};
