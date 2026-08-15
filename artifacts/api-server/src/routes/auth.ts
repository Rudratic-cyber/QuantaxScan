import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import {
  DEFAULT_RETURN_TO,
  OAUTH_TRANSACTION_TTL_MS,
  codeChallengeFor,
  configuredProviders,
  providerById,
  randomState,
  randomVerifier,
  redirectUriFor,
  safeReturnTo,
  secretsMatch,
  type OAuthTransaction,
} from "../lib/auth/providers";
import {
  IdentityConflictError,
  ensurePersonalOrganization,
  loadUser,
  membershipsFor,
  pickActiveOrganization,
  resolveUserForIdentity,
  type Membership,
} from "../lib/auth/identity";
import {
  ABSOLUTE_SESSION_LIFETIME_MS,
  SESSIONS_ENABLED,
  cookieIsSecure,
  sessionCookieName,
} from "../lib/auth/session";
import "../lib/auth/types";

/**
 * Sign-in — docs/Claude/13-auth-and-tenancy.md §3.4, §3.5, §3.7 and §3.10.
 *
 * Every route here is in `PUBLIC_ROUTES`: they are how a caller *becomes*
 * authenticated, so requiring authentication to reach them would deadlock.
 *
 * This file opens no organisation scope of its own. Everything that touches
 * the database goes through `lib/auth/identity.ts`, which uses `withUserScope`
 * for the organisation-scoped tables and `withoutOrgScope` for the three that
 * genuinely have no organisation. That keeps the "routes never import `db`"
 * rule intact and keeps the scope decisions in one readable place.
 */

const router: IRouter = Router();

function sessionsUnavailable(res: Response): void {
  // 501, not 404: the routes exist, the deployment has not configured an
  // identity provider or a session secret. A 404 would read as "this build has
  // no sign-in", which is a different and wrong statement.
  res.status(501).json({ error: "Sign-in is not configured on this deployment" });
}

/** GET /api/auth/providers — drives the sign-in page; an unconfigured provider must not render a dead button. */
router.get("/auth/providers", (_req: Request, res: Response): void => {
  const providers = SESSIONS_ENABLED
    ? configuredProviders().map((provider) => ({ id: provider.id, label: provider.label }))
    : [];
  res.json({ providers });
});

/**
 * GET /api/auth/:provider/start
 *
 * `saveUninitialized: false`, so writing the transaction below is what creates
 * the session row: an anonymous visitor who never clicks sign-in never touches
 * the database.
 */
router.get("/auth/:provider/start", (req: Request, res: Response): void => {
  if (!SESSIONS_ENABLED || !req.session) {
    sessionsUnavailable(res);
    return;
  }

  const provider = providerById(String(req.params.provider));
  if (!provider) {
    // 404 rather than 400: an unconfigured provider is indistinguishable from
    // one that does not exist, and there is no reason to enumerate.
    res.status(404).json({ error: "Unknown provider" });
    return;
  }

  const verifier = randomVerifier();
  const transaction: OAuthTransaction = {
    provider: provider.id,
    verifier,
    state: randomState(),
    nonce: provider.usesNonce ? randomState() : null,
    returnTo: safeReturnTo(req.query.returnTo),
    createdAt: Date.now(),
    // Linking a second provider to an already-signed-in account is §3.6's
    // explicit-link path; it is only ever "link" when somebody is already
    // signed in, which is checked again on the way back.
    mode: req.query.mode === "link" && req.session.userId ? "link" : "signin",
  };
  req.session.oauth = transaction;

  const redirectUri = redirectUriFor(provider.id);
  const url = provider.buildAuthorizationUrl({
    state: transaction.state,
    nonce: transaction.nonce,
    codeChallenge: codeChallengeFor(verifier),
    redirectUri,
  });

  // Save explicitly: the redirect must not race the session write, or the
  // callback arrives before the transaction it has to match against exists.
  req.session.save((err) => {
    if (err) {
      logger.error({ err }, "failed to persist the OAuth transaction");
      res.status(500).json({ error: "Sign-in could not be started" });
      return;
    }
    res.redirect(302, url);
  });
});

/** GET /api/auth/:provider/callback */
router.get("/auth/:provider/callback", async (req: Request, res: Response): Promise<void> => {
  if (!SESSIONS_ENABLED || !req.session) {
    sessionsUnavailable(res);
    return;
  }

  const transaction = req.session.oauth;
  // **Single use.** Cleared before the exchange, so a replayed callback fails
  // even when the code would still have been accepted upstream.
  delete req.session.oauth;

  const failure = validateTransaction(transaction, req);
  if (failure) {
    res.status(400).json({ error: failure });
    return;
  }
  const tx = transaction as OAuthTransaction;

  const provider = providerById(tx.provider);
  if (!provider) {
    res.status(400).json({ error: "Unknown provider" });
    return;
  }

  const linkingAs = tx.mode === "link" ? (req.session.userId ?? null) : null;

  try {
    const identity = await provider.exchange({
      code: String(req.query.code),
      verifier: tx.verifier,
      redirectUri: redirectUriFor(provider.id),
      nonce: tx.nonce,
    });

    const { userId, created } = await resolveUserForIdentity(identity, linkingAs);

    let memberships = await membershipsFor(userId);
    if (memberships.length === 0 && created) {
      // §3.7 step 1. Only for a genuinely new user: an existing account with
      // no memberships had them revoked, and silently minting a fresh personal
      // organisation would hand back access somebody deliberately removed.
      memberships = [await ensurePersonalOrganization(userId, displayNameFor(identity))];
    }
    const active = pickActiveOrganization(memberships, undefined);

    // **Session fixation.** Regenerate before writing anything that says who
    // the caller is, so a session id an attacker planted before sign-in is not
    // the one that ends up authenticated.
    await regenerate(req);
    req.session.userId = userId;
    req.session.organizationId = active?.organizationId;
    req.session.loginAt = Date.now();
    req.session.absoluteExpiresAt = Date.now() + ABSOLUTE_SESSION_LIFETIME_MS;
    await save(req);

    res.redirect(302, tx.returnTo || DEFAULT_RETURN_TO);
  } catch (err) {
    if (err instanceof IdentityConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    logger.error({ err, provider: tx.provider }, "sign-in callback failed");
    res.status(400).json({ error: "Sign-in failed" });
  }
});

/**
 * GET /api/auth/session
 *
 * 200 with `{ user: null }` when anonymous, never 401 — it is called on every
 * page load including by visitors who have never signed in, and a 401 would be
 * indistinguishable from a real failure.
 */
router.get("/auth/session", async (req: Request, res: Response): Promise<void> => {
  const principal = req.principal;
  if (!principal || principal.kind !== "session") {
    res.json({ user: null, organization: null, memberships: [] });
    return;
  }

  const user = await loadUser(principal.userId);
  res.json({
    user,
    // The active organisation is reported as an id and role rather than a
    // name, because §7.4's "a solo user is an organisation of one and never
    // meets the concept" is implemented by the client rendering nothing when
    // there is only one membership.
    organization:
      principal.organizationId === null
        ? null
        : { id: principal.organizationId, role: principal.role },
    memberships: principal.memberships,
  });
});

/** POST /api/auth/logout — local sign-out only; see §3.10 on why RP-initiated logout is not specified. */
router.post("/auth/logout", (req: Request, res: Response): void => {
  if (!req.session) {
    res.status(204).end();
    return;
  }
  req.session.destroy((err) => {
    if (err) logger.warn({ err }, "session destroy failed");
    // Clearing the cookie with the same attributes it was set with is what
    // makes the browser actually drop it.
    // Same name and same attributes it was set with — a browser will not drop
    // a cookie cleared under a different `Secure`/`Path` pair.
    res.clearCookie(sessionCookieName(), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: cookieIsSecure(),
    });
    res.status(204).end();
  });
});

/**
 * POST /api/auth/organizations/:id/select — switch the active organisation.
 *
 * Protected, not public: it changes what the caller can read. 403 unless the
 * caller is a member, decided against the memberships `resolvePrincipal` just
 * re-read rather than against anything the client sent.
 */
router.post("/auth/organizations/:id/select", (req: Request, res: Response): void => {
  const principal = req.principal;
  if (!principal || principal.kind !== "session" || !req.session) {
    res.status(403).json({ error: "Not signed in" });
    return;
  }

  const organizationId = Number(req.params.id);
  if (!Number.isInteger(organizationId)) {
    res.status(400).json({ error: "Invalid organisation id" });
    return;
  }

  const membership = principal.memberships.find(
    (m: Membership) => m.organizationId === organizationId,
  );
  if (!membership) {
    res.status(403).json({ error: "Not a member of that organisation" });
    return;
  }

  req.session.organizationId = organizationId;
  res.json({ organization: { id: organizationId, role: membership.role } });
});

export default router;

// ── helpers ──────────────────────────────────────────────────────────────────

function displayNameFor(identity: { firstName: string | null; email: string | null }): string | null {
  if (identity.firstName) return identity.firstName;
  if (identity.email) return identity.email.split("@")[0];
  return null;
}

/**
 * Every reason a callback is refused, in one place so none of them can be
 * skipped by an early return added later. `state` is compared in constant
 * time — it is a secret the browser round-trips, and a leaked comparison
 * timing is a CSRF bypass on the callback specifically.
 */
function validateTransaction(transaction: OAuthTransaction | undefined, req: Request): string | null {
  if (!transaction) return "No sign-in is in progress";
  if (transaction.provider !== String(req.params.provider)) return "Provider mismatch";
  if (Date.now() - transaction.createdAt > OAUTH_TRANSACTION_TTL_MS) return "Sign-in expired; please try again";
  if (typeof req.query.error === "string") return "The provider refused the sign-in";
  if (typeof req.query.code !== "string" || req.query.code === "") return "No authorization code";
  const state = req.query.state;
  if (typeof state !== "string" || !secretsMatch(state, transaction.state)) return "State mismatch";
  return null;
}

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function save(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}
