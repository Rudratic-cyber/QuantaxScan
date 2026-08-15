/**
 * F1 — sign-in, end to end against the real stack: real Postgres, real API
 * server, real session store, real cookies. No `page.route` appears in this
 * file.
 *
 * **What this spec deliberately does not do is stand up an OAuth provider.**
 * The full authorization-code flow — `state`, PKCE, single-use, replay — is
 * proven against an `http` stub at the unit level, which is where a provider
 * stub belongs: `openid-client` validates an `id_token`'s signature, `iss`,
 * `aud` and `nonce`, so an end-to-end Google flow would need a JWKS server and
 * a token minter, and building one here would test the stub more than the
 * product.
 *
 * What end-to-end *can* prove, and what this file therefore asserts, is the set
 * of properties visible from outside with no provider at all — every one of
 * which is a security property rather than a happy path:
 *
 *  1. the provider list backs the deferral claim: GitHub is offered, Google and
 *     Microsoft are not, because a provider nobody implemented must not appear
 *     as though a user could pick it;
 *  2. an anonymous caller gets **200 with `user: null`**, not 401 — this is
 *     called on every page load and an anonymous visitor is a normal state, so
 *     a 401 here would be indistinguishable from a real failure;
 *  3. a callback with no `state`, a forged `state`, or an unknown provider
 *     fails closed rather than establishing a session;
 *  4. an unknown *or unconfigured* provider is a 404 either way, so the set a
 *     deployment has configured cannot be enumerated by an anonymous caller;
 *  5. logout succeeds with no session, because 401ing the one action whose job
 *     is to end a session is the wrong answer;
 *  6. organisation switching — the only non-public route here — refuses an
 *     unauthenticated caller.
 */
import { test, expect } from "./support/fixtures";

interface AuthSession {
  user: { id: string; email: string | null } | null;
  organization: { id: number; role: string } | null;
  memberships: Array<{ organizationId: number; role: string }>;
}

test.describe("F1 — sign-in, from outside", () => {
  test("the provider list offers only what is actually implemented", async ({ publicApi }) => {
    const response = await publicApi.get("/api/auth/providers");
    expect(response.status()).toBe(200);

    const { providers } = (await response.json()) as { providers: Array<{ id: string; label: string }> };
    const ids = providers.map((p) => p.id);

    // Google and Microsoft are written down in the provider registry — their
    // claim shapes differ in ways worth recording next to each other — but
    // neither is implemented. Appearing here would offer a user a button that
    // cannot work, which is the same class of error as a status table saying
    // `built` for something that is not.
    expect(ids).not.toContain("google");
    expect(ids).not.toContain("microsoft");

    // When sessions are configured at all, GitHub is the one that works.
    if (ids.length > 0) {
      expect(ids).toContain("github");
      for (const provider of providers) expect(provider.label.length).toBeGreaterThan(0);
    }
  });

  test("an anonymous caller gets a session shape, not a 401", async ({ publicApi }) => {
    const response = await publicApi.get("/api/auth/session");

    // The whole point. This is called on every page load, including by people
    // who have never signed in.
    expect(response.status()).toBe(200);
    const session = (await response.json()) as AuthSession;
    expect(session.user).toBeNull();
    expect(session.organization).toBeNull();
    expect(session.memberships).toEqual([]);
  });

  test("a callback with no state, or a forged one, does not establish a session", async ({ publicApi }) => {
    // No state at all.
    const bare = await publicApi.get("/api/auth/github/callback");
    expect([400, 404, 503]).toContain(bare.status());

    // A state the server never issued. There is no stored transaction to match
    // it against, so this must fail rather than fall through to a session.
    const forged = await publicApi.get(
      "/api/auth/github/callback?code=not-a-real-code&state=forged-state-value-000",
    );
    expect([400, 404, 503]).toContain(forged.status());

    // And nothing about either attempt signed anyone in.
    const session = (await (await publicApi.get("/api/auth/session")).json()) as AuthSession;
    expect(session.user).toBeNull();
  });

  test("an unknown provider is refused, and refused the same way an unconfigured one is", async ({ publicApi }) => {
    const start = await publicApi.get("/api/auth/definitely-not-a-provider/start");
    const callback = await publicApi.get("/api/auth/definitely-not-a-provider/callback?state=x");

    // `start` answers 404 for unknown *and* unconfigured, deliberately: which
    // providers a deployment has enabled is not something an anonymous caller
    // should be able to enumerate by comparing status codes. (503 is the
    // whole-feature-off answer and is equally uninformative.)
    expect([404, 503]).toContain(start.status());

    // `callback` answers 400 here rather than 404, and the ordering behind that
    // is right: it validates the session's stored transaction *before* it looks
    // the provider up, so a callback carrying a `state` nobody issued is
    // rejected without any provider-specific work happening at all. Both codes
    // are refusals and neither confirms whether the provider exists.
    expect([400, 404, 503]).toContain(callback.status());
  });

  test("logout with no session succeeds rather than 401ing", async ({ publicApi }) => {
    const response = await publicApi.post("/api/auth/logout");
    // Idempotent and public: 401ing the one action whose job is to end a
    // session would make an expired session impossible to clear.
    expect(response.status()).toBe(204);
  });

  test("switching organisation is the one route here that refuses an anonymous caller", async ({ publicApi }) => {
    const response = await publicApi.post("/api/auth/organizations/1/select");
    // It acts on behalf of somebody already signed in, so unlike its five
    // siblings it is not in PUBLIC_ROUTES.
    expect([401, 403]).toContain(response.status());
  });

  test("the API key still authenticates, unchanged by sign-in existing", async ({ api }) => {
    // F1 added a second kind of principal beside the shared key rather than
    // replacing it. Every existing deployment and every other spec in this
    // suite depends on that staying true.
    const response = await api.get("/api/projects");
    expect(response.status()).toBe(200);
  });
});
