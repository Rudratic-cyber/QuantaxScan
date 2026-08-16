import type { RequestHandler } from "express";
import { roleAtLeast, type OrgRole } from "@workspace/db/roles";
import { isPublic } from "./auth";
import { logger } from "./logger";

/**
 * RBAC stage 3 — write gating. docs/Claude/15-rbac-design.md §4.4.
 *
 * **One gate, mounted once**, rather than a decorator on each of seventy
 * routes. A per-route check is a rule you can forget to apply, and the failure
 * of forgetting is silent: the route works, for everybody, and nothing says it
 * should not have. Mounted centrally, forgetting is impossible — the only
 * question left is whether a route needs *more* than the default.
 *
 * ## The default is the whole design
 *
 * ```
 * GET / HEAD              → viewer   (a read)
 * everything else         → member   (a write)
 * named in OVERRIDES      → whatever it says
 * ```
 *
 * A new route that nobody thinks about is therefore **closed to viewers**,
 * because anything that is not a read is assumed to change something. The
 * alternative default — allow unless named — means the day someone adds
 * `POST /something-destructive` without touching this file, every read-only
 * account in every tenant can call it. Defaults decide what happens when
 * attention runs out, so this one is set for that case rather than the
 * attentive one.
 *
 * The method-based read/write split is deliberately cruder than a route list
 * and that is its value: it cannot drift from reality, because it is derived
 * from the request rather than maintained beside it. `OVERRIDES` is only for
 * routes needing *more* than their method implies.
 *
 * ## What this gate does not do
 *
 * It does not scope *reads*. A viewer restricted to one division is confined by
 * the row-level-security policies (stage 4), not here — for the same reason
 * organisation isolation is: a filter in application code is a filter somebody
 * can forget, and the failure returns another division's rows rather than an
 * error.
 */

/** Routes needing more than their method implies. Order matters: first match wins. */
export const ROUTE_ROLE_OVERRIDES: ReadonlyArray<{ method: string; path: RegExp; role: OrgRole }> = [
  // F4 — a stored credential is a customer's read-only key into their own
  // cloud, and the largest blast radius of any row in this product. A member
  // who submits scans has no reason to hold one. The GET is listed too: it
  // returns metadata rather than material, but *which* cloud accounts a
  // company has connected is commercially sensitive on its own.
  { method: "GET", path: /^\/credentials$/, role: "admin" },
  { method: "POST", path: /^\/credentials$/, role: "admin" },
  { method: "POST", path: /^\/credentials\/[^/]+\/revoke$/, role: "admin" },

  // Publishing a report outside the tenant. `GET /reports/:id` is
  // public-by-link and the id is the only control, so creating one is a
  // decision to publish, not a routine action.
  { method: "POST", path: /^\/reports$/, role: "admin" },

  // Deleting a project takes its scans, findings and assets with it.
  { method: "DELETE", path: /^\/projects\/[^/]+$/, role: "admin" },

  // RBAC's own management surface (stage 5). Listed now so the routes cannot
  // ship ungated later — a gate added after the route is a window that was
  // open in between.
  { method: "POST", path: /^\/divisions$/, role: "admin" },
  { method: "PATCH", path: /^\/divisions\/[^/]+$/, role: "admin" },
  { method: "DELETE", path: /^\/divisions\/[^/]+$/, role: "admin" },
  { method: "POST", path: /^\/divisions\/[^/]+\/grants$/, role: "admin" },
  { method: "DELETE", path: /^\/divisions\/[^/]+\/grants\/[^/]+$/, role: "admin" },
  // C8 — granting a waiver is accepting a risk on the organisation's behalf.
  // The specific hazard the default gate would miss: the person best placed to
  // silence an inconvenient finding is the member who submitted the scan that
  // raised it, and self-service risk acceptance is how an inventory becomes
  // fiction. Revoking one is NOT listed — it stays on the default `member`
  // gate, because restoring a finding to the working list is the fail-safe
  // direction and must not be harder than suppressing it.
  { method: "POST", path: /^\/waivers$/, role: "admin" },

  // Discovery stage 0 — the credentialed routes, gated before any of them
  // exists. Same reasoning that put RBAC's own management surface in this list
  // before it shipped: *a gate added after the route is a window that was open
  // in between.*
  //
  // Two distinct reasons, both admin:
  //   - A `/poll` route redeems a stored credential. Holding one is already
  //     admin-only (see `/credentials` above), so being able to *spend* one
  //     without holding it would route straight around that decision.
  //   - A discovery run is an outbound act against the customer's own
  //     infrastructure that costs money in provider API calls, and its result
  //     names which accounts they operate.
  //
  // Deliberately NOT listed: `POST /projects/:id/discovery` (D8, certificate
  // transparency). It reads a public log, redeems nothing and spends nothing of
  // the customer's, so it stays on the default `member` gate — gating it would
  // be ceremony rather than control.
  { method: "POST", path: /^\/projects\/[^/]+\/[^/]+\/poll$/, role: "admin" },
  { method: "POST", path: /^\/projects\/[^/]+\/discovery\/cloud$/, role: "admin" },

  { method: "GET", path: /^\/organization\/members$/, role: "admin" },
  { method: "POST", path: /^\/organization\/members$/, role: "admin" },
  { method: "PATCH", path: /^\/organization\/members\/[^/]+$/, role: "admin" },
  { method: "DELETE", path: /^\/organization\/members\/[^/]+$/, role: "admin" },
];

/**
 * Routes that authenticate a caller rather than acting for one. They run
 * before a role exists, so gating them on a role is a deadlock — the same
 * reasoning that puts them in `PUBLIC_ROUTES`, applied one layer along.
 *
 * `POST /auth/organizations/:id/select` is deliberately absent: it acts for
 * somebody already signed in, and it re-checks membership itself.
 */
const ROLE_EXEMPT: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/auth\/logout$/ },
  { method: "POST", path: /^\/auth\/organizations\/[^/]+\/select$/ },
];

/** A read is anything that cannot change state. */
function isRead(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/**
 * The role a request needs. Exported so `cross-tenant.test.ts` can assert the
 * manifest and the gate agree, rather than the manifest describing an
 * intention nothing enforces.
 */
export function requiredRoleFor(method: string, path: string): OrgRole {
  for (const entry of ROUTE_ROLE_OVERRIDES) {
    if (entry.method === method && entry.path.test(path)) return entry.role;
  }
  return isRead(method) ? "viewer" : "member";
}

/**
 * Deny anything the principal's role does not reach.
 *
 * Mounted after `requireAuth`, so by the time this runs the request is known to
 * be authenticated and to have an organisation. A principal that somehow
 * reaches here without a role is refused: an unresolved role is not evidence of
 * permission.
 */
export const enforceRole: RequestHandler = (req, res, next) => {
  if (isPublic(req.method, req.path)) {
    next();
    return;
  }
  if (ROLE_EXEMPT.some((entry) => entry.method === req.method && entry.path.test(req.path))) {
    next();
    return;
  }

  const principal = req.principal;
  if (!principal || principal.kind === "anonymous") {
    // Unreachable — requireAuth has already answered 401 — but this must not
    // be the layer that assumes so.
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const required = requiredRoleFor(req.method, req.path);
  const held = principal.kind === "apiKey" ? principal.role : principal.role;

  if (!roleAtLeast(held, required)) {
    logger.warn(
      { method: req.method, path: req.path, required, held: held ?? "none", kind: principal.kind },
      "Rejected request whose role does not reach the route",
    );
    // 403 rather than 404: the caller is authenticated and the route exists.
    // Pretending otherwise would make a permissions problem indistinguishable
    // from a typo, and the person hitting it cannot fix what they cannot see.
    res.status(403).json({
      error: `This action needs the ${required} role. You have ${held ?? "no role"} in this organisation.`,
    });
    return;
  }

  next();
};
