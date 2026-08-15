import { sql } from "drizzle-orm";
import { withUserScope, withoutOrgScope } from "@workspace/db";
// From the subpath, not the barrel: the API test suite mocks `@workspace/db`
// with a pglite-backed handle and re-exports only the schema and the scope
// helpers, so the barrel's `executeRows` is not there. Every route in this
// codebase imports it the same way.
import { executeRows, type ScopedTx } from "@workspace/db/org-scope";
import type { NormalizedIdentity } from "./providers";

/**
 * Who a sign-in resolves to, and which organisation they act in.
 * docs/Claude/13-auth-and-tenancy.md §3.6 and §3.7.
 *
 * ## §3.6 is the account-takeover surface, and it has one dangerous answer
 *
 * `users.email` is unique and nullable, which makes matching on it tempting.
 * Matching on email means: an attacker who can make any provider assert a
 * victim's address signs in *as the victim*. So `(provider, provider_user_id)`
 * — Google `sub`, Microsoft `oid`, GitHub `id` — is the only join key, and the
 * unique index `user_identities_provider_subject_idx` is what enforces it in
 * the database rather than here.
 *
 * Email is used for exactly one thing: auto-linking a *second* provider to an
 * existing account, and only when that provider asserts the address as
 * verified. Every other path creates a new user. The deliberate consequence is
 * occasional duplicate accounts, resolvable by an explicit link; the
 * alternative is silent account takeover.
 */

export interface Membership {
  organizationId: number;
  role: string;
}

export interface UserProfile {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

const UNSCOPED_REASON = "sign-in identity resolution";

/**
 * Emails are compared case-folded and stored lower-case: `users.email` is
 * unique, and two providers asserting `Sam@x.com` and `sam@x.com` must not
 * produce two rows.
 */
function foldEmail(email: string | null): string | null {
  return email === null ? null : email.trim().toLowerCase() || null;
}

/**
 * §3.6, in one place, returning the user this sign-in is.
 *
 * `currentUserId` is the already-signed-in user when the flow was started in
 * `mode: "link"`, and null otherwise. It is what turns an unverified email
 * from "create a second account" into "attach this provider to the account
 * that is already proven".
 */
export async function resolveUserForIdentity(
  identity: NormalizedIdentity,
  currentUserId: string | null,
): Promise<{ userId: string; created: boolean }> {
  const email = foldEmail(identity.email);

  return withoutOrgScope(UNSCOPED_REASON, async (tx) => {
    // 1. The only join key.
    const existing = await executeRows<{ user_id: string }>(
      tx,
      sql`select user_id from user_identities
           where provider = ${identity.provider} and provider_user_id = ${identity.providerUserId}`,
    );

    if (existing.length > 0) {
      const userId = existing[0].user_id;
      if (currentUserId !== null && currentUserId !== userId) {
        // Linking a provider that already belongs to somebody else would
        // merge two accounts on the strength of one of them. Refuse.
        throw new IdentityConflictError(
          "That account is already linked to a different QuantaXscan user.",
        );
      }
      await tx.execute(
        sql`update user_identities
               set last_login_at = now(), email = ${email}, email_verified = ${identity.emailVerified}
             where provider = ${identity.provider} and provider_user_id = ${identity.providerUserId}`,
      );
      await refreshProfile(tx, userId, identity, email);
      return { userId, created: false };
    }

    // 2. An explicit link attaches to the proven account, whatever the
    //    provider says about the address.
    if (currentUserId !== null) {
      await insertIdentity(tx, currentUserId, identity, email);
      return { userId: currentUserId, created: false };
    }

    // 3. Auto-link, but only on a provider-asserted verified address.
    //    Microsoft never reaches here: §3.3 pins its emailVerified to false
    //    because Microsoft's own reference says the `email` claim "isn't
    //    guaranteed to be correct and is mutable over time".
    if (identity.emailVerified && email !== null) {
      const byEmail = await executeRows<{ id: string }>(
        tx,
        sql`select id from users where lower(email) = ${email}`,
      );
      if (byEmail.length > 0) {
        await insertIdentity(tx, byEmail[0].id, identity, email);
        await refreshProfile(tx, byEmail[0].id, identity, email);
        return { userId: byEmail[0].id, created: false };
      }
    }

    // 4. A new user. The address is only stored when the provider vouched for
    //    it — an unverified address on a new row would be an email match
    //    waiting to happen the next time someone signs in with a verified one.
    const storedEmail = identity.emailVerified ? email : null;
    const created = await executeRows<{ id: string }>(
      tx,
      sql`insert into users (email, first_name, last_name, profile_image_url)
            values (${storedEmail}, ${identity.firstName}, ${identity.lastName}, ${identity.profileImageUrl})
          returning id`,
    );
    const userId = created[0].id;
    await insertIdentity(tx, userId, identity, email);
    return { userId, created: true };
  });
}

export class IdentityConflictError extends Error {}

async function insertIdentity(
  tx: ScopedTx,
  userId: string,
  identity: NormalizedIdentity,
  email: string | null,
): Promise<void> {
  await tx.execute(
    sql`insert into user_identities
          (user_id, provider, provider_user_id, provider_tenant_id, email, email_verified, last_login_at)
        values (${userId}, ${identity.provider}, ${identity.providerUserId},
                ${identity.providerTenantId}, ${email}, ${identity.emailVerified}, now())`,
  );
}

/**
 * Profile columns follow the provider, because that is what the user sees and
 * changes there. `email` is only ever *added*, never overwritten with an
 * unverified value — otherwise a second, unverified provider could rewrite the
 * address that the auto-link branch above matches on.
 */
async function refreshProfile(
  tx: ScopedTx,
  userId: string,
  identity: NormalizedIdentity,
  email: string | null,
): Promise<void> {
  await tx.execute(
    sql`update users
           set first_name = coalesce(${identity.firstName}, first_name),
               last_name = coalesce(${identity.lastName}, last_name),
               profile_image_url = coalesce(${identity.profileImageUrl}, profile_image_url),
               email = case when email is null and ${identity.emailVerified} then ${email} else email end,
               updated_at = now()
         where id = ${userId}`,
  );
}

export async function loadUser(userId: string): Promise<UserProfile | null> {
  const rows = await withoutOrgScope(UNSCOPED_REASON, (tx) =>
    executeRows<{
      id: string;
      email: string | null;
      first_name: string | null;
      last_name: string | null;
      profile_image_url: string | null;
    }>(
      tx,
      sql`select id, email, first_name, last_name, profile_image_url from users where id = ${userId}`,
    ),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    profileImageUrl: row.profile_image_url,
  };
}

/**
 * Which organisations this user belongs to, read under
 * `organization_members`' own policy via its `user_id` branch.
 *
 * **This is the authorisation decision, and it is re-read on every
 * authenticated request** (§6.3). `req.session.organizationId` is a cache of
 * its result and never a grant: without this read, revoking a member leaves
 * them with access until their cookie expires — up to seven days under the
 * absolute cap.
 */
export async function membershipsFor(userId: string): Promise<Membership[]> {
  const rows = await withUserScope(userId, ({ tx }) =>
    executeRows<{ organization_id: number; role: string }>(
      tx,
      sql`select organization_id, role from organization_members order by created_at asc, organization_id asc`,
    ),
  );
  return rows.map((row) => ({ organizationId: row.organization_id, role: row.role }));
}

/**
 * §3.7. Never trusts the session's organisation on its own — `preferred` is
 * only honoured when it appears in the memberships just read.
 *
 * Returns null when the user belongs to nothing, which is a real state: an
 * account whose only membership was revoked while they were signed in. It must
 * NOT fall back to a default organisation. A "sensible default" here is a
 * cross-tenant read, and it is the single failure this whole lane is about.
 */
export function pickActiveOrganization(
  memberships: Membership[],
  preferred: number | undefined,
): Membership | null {
  if (memberships.length === 0) return null;
  if (preferred !== undefined) {
    const match = memberships.find((m) => m.organizationId === preferred);
    if (match) return match;
  }
  // "the oldest" — the query above orders by created_at.
  return memberships[0];
}

/**
 * §3.7 step 1: a brand-new user gets a personal organisation, owned by them.
 *
 * The whole thing is ONE transaction, and the order inside it is forced rather
 * than chosen. `organizations`' policy admits the insert (`personal = true`
 * stamped with the acting user) and its `created_by_user_id` branch is what
 * makes `RETURNING id` readable — at that instant the creator is a member of
 * nothing, so neither other branch can see the row. Only then is the
 * transaction promoted into the new organisation, which is what lets
 * `organization_members`' unchanged `WITH CHECK` accept the owner row. See
 * lib/db/sql/tenant-isolation.sql, where both halves are written down.
 *
 * Idempotent by `slug`: a retry after a crash finds the existing personal
 * organisation rather than creating a second one.
 */
export async function ensurePersonalOrganization(
  userId: string,
  displayName: string | null,
): Promise<Membership> {
  const slug = `user-${userId}`;
  const name = displayName && displayName.trim() !== "" ? displayName.trim() : "Personal";

  return withUserScope(userId, async ({ tx, enterOrganization }) => {
    const existing = await executeRows<{ id: number }>(
      tx,
      sql`select id from organizations where slug = ${slug}`,
    );
    const organizationId =
      existing[0]?.id ??
      (
        await executeRows<{ id: number }>(
          tx,
          sql`insert into organizations (name, slug, personal, created_by_user_id)
                values (${name}, ${slug}, true, ${userId})
              returning id`,
        )
      )[0].id;

    await enterOrganization(organizationId);
    await tx.execute(
      sql`insert into organization_members (organization_id, user_id, role)
            values (${organizationId}, ${userId}, 'owner')
          on conflict (organization_id, user_id) do nothing`,
    );

    return { organizationId, role: "owner" };
  });
}
