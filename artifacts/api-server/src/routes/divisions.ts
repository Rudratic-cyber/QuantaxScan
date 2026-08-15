import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  withOrg,
  divisionsTable,
  divisionGrantsTable,
  organizationMembersTable,
  projectsTable,
} from "@workspace/db";
import { DIVISION_ROLE_VALUES, ORG_ROLE_VALUES } from "@workspace/db/roles";
import { orgContextFor } from "../lib/principal";
import { logger } from "../lib/logger";

/**
 * RBAC stage 5 — the management surface. docs/Claude/15-rbac-design.md §5.
 *
 * Until this existed, a division could only be created by an operator with
 * database access, which is fine for the first tenant and not for the tenth.
 *
 * Every write here is `admin`-gated centrally in `lib/require-role.ts` rather
 * than by a check in each handler — see that file for why the gate is one
 * middleware and not seventy decorators. The handlers below therefore assume
 * the caller is already known to be an admin, and concern themselves only with
 * what an admin can still get wrong.
 *
 * **The list is deliberately readable by a viewer.** A person restricted to
 * Payments sees that Retail exists, by name, holding no data of theirs. Hiding
 * its existence entirely makes "why can't I see Retail?" unanswerable by the
 * one person experiencing it, and support tickets are not a security control.
 */

const router: IRouter = Router();

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseId(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(String(value), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Postgres unique violation — `divisions_org_slug_idx`. Walks `cause`, like the credentials route. */
function isUniqueViolation(err: unknown): boolean {
  for (let current: unknown = err; current != null; current = (current as { cause?: unknown }).cause) {
    if (typeof current === "object" && (current as { code?: string }).code === "23505") return true;
  }
  return false;
}

/** GET /api/divisions — every division in this organisation, with how many projects each holds. */
router.get("/divisions", async (req, res): Promise<void> => {
  const rows = await withOrg(orgContextFor(req), async (tx) => {
    const divisions = await tx.select().from(divisionsTable).orderBy(asc(divisionsTable.name));
    const projects = await tx
      .select({ id: projectsTable.id, divisionId: projectsTable.divisionId })
      .from(projectsTable);

    return divisions.map((division) => ({
      id: division.id,
      name: division.name,
      slug: division.slug,
      description: division.description,
      createdAt: division.createdAt.toISOString(),
      // Counted from what this caller can see, not from a stored total: a
      // cached count would be a second source of truth able to disagree with
      // the policy that decides what is visible.
      projects: projects.filter((project) => project.divisionId === division.id).length,
    }));
  });

  res.json({
    divisions: rows,
    // The number a reader needs to interpret the rest: projects belonging to no
    // division are visible to everyone in the tenant, and are not a division's
    // omission.
    organizationWideProjects: await withOrg(orgContextFor(req), async (tx) => {
      const projects = await tx.select({ divisionId: projectsTable.divisionId }).from(projectsTable);
      return projects.filter((project) => project.divisionId === null).length;
    }),
  });
});

/** POST /api/divisions */
router.post("/divisions", async (req, res): Promise<void> => {
  const { name, slug, description } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "A division needs a name." });
    return;
  }
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    res.status(400).json({
      error: "`slug` must be lower-case letters, digits and single hyphens — it appears in URLs.",
    });
    return;
  }

  const ctx = orgContextFor(req);
  try {
    const created = await withOrg(ctx, async (tx) => {
      const [row] = await tx
        .insert(divisionsTable)
        .values({
          organizationId: ctx.organizationId,
          name: name.trim(),
          slug,
          description: typeof description === "string" && description.trim().length > 0 ? description.trim() : null,
          // Null for the API-key principal, which has no person behind it —
          // a manufactured attribution is worse than an absent one.
          createdByUserId: ctx.userId === "" ? null : ctx.userId,
        })
        .returning();
      return row;
    });

    logger.info({ divisionId: created.id, route: "POST /divisions" }, "division created");
    res.status(201).json(created);
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: `A division with the slug "${slug}" already exists in this organisation.` });
      return;
    }
    throw err;
  }
});

/** PATCH /api/divisions/:id — rename or re-describe. The slug is deliberately immutable: it appears in URLs people have bookmarked. */
router.patch("/divisions/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid division ID" });
    return;
  }
  const { name, description } = (req.body ?? {}) as Record<string, unknown>;

  const updates: Record<string, unknown> = {};
  if (typeof name === "string" && name.trim().length > 0) updates.name = name.trim();
  if (typeof description === "string") updates.description = description.trim() || null;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update. Send `name` or `description`." });
    return;
  }

  const updated = await withOrg(orgContextFor(req), async (tx) => {
    const [row] = await tx.update(divisionsTable).set(updates).where(eq(divisionsTable.id, id)).returning();
    return row ?? null;
  });

  if (!updated) {
    res.status(404).json({ error: "Division not found" });
    return;
  }
  res.json(updated);
});

/**
 * DELETE /api/divisions/:id
 *
 * The projects inside it are **not** deleted: `projects.division_id` is
 * `ON DELETE SET NULL`, so they become organisation-wide — the state they were
 * in before divisions existed, and the only safe reading of "the team was
 * dissolved". Deleting a team's work because the team was reorganised would be
 * a data-loss bug wearing a tidy-up's clothes.
 */
router.delete("/divisions/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid division ID" });
    return;
  }

  const outcome = await withOrg(orgContextFor(req), async (tx) => {
    const affected = await tx
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.divisionId, id));
    const [deleted] = await tx.delete(divisionsTable).where(eq(divisionsTable.id, id)).returning();
    return deleted ? { projectsReleased: affected.length } : null;
  });

  if (!outcome) {
    res.status(404).json({ error: "Division not found" });
    return;
  }
  // Say how many projects just became organisation-wide. Silence here would
  // let an admin dissolve a division without realising they had widened who
  // can see its work.
  res.json(outcome);
});

/** POST /api/divisions/:id/grants — grant a member a role on this division. */
router.post("/divisions/:id/grants", async (req, res): Promise<void> => {
  const divisionId = parseId(req.params.id);
  if (divisionId === null) {
    res.status(400).json({ error: "Invalid division ID" });
    return;
  }
  const { userId, role } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof userId !== "string" || userId.trim().length === 0) {
    res.status(400).json({ error: "`userId` is required." });
    return;
  }
  if (typeof role !== "string" || !(DIVISION_ROLE_VALUES as readonly string[]).includes(role)) {
    res.status(400).json({
      error: `\`role\` must be one of ${DIVISION_ROLE_VALUES.join(", ")}. A division has no owner — ownership is a fact about the organisation.`,
    });
    return;
  }

  const ctx = orgContextFor(req);
  const outcome = await withOrg(ctx, async (tx) => {
    // Both parents confirmed *inside* the scope. A foreign key is checked with
    // row-level security bypassed, so PostgreSQL would accept another
    // organisation's division id or a stranger's user id here.
    const [division] = await tx.select({ id: divisionsTable.id }).from(divisionsTable).where(eq(divisionsTable.id, divisionId));
    if (!division) return { error: "division" as const };

    const [member] = await tx
      .select({ userId: organizationMembersTable.userId })
      .from(organizationMembersTable)
      .where(eq(organizationMembersTable.userId, userId));
    // Granting a division to somebody who is not in the organisation would
    // create access to a tenant they were never admitted to.
    if (!member) return { error: "member" as const };

    const [row] = await tx
      .insert(divisionGrantsTable)
      .values({ organizationId: ctx.organizationId, divisionId, userId, role })
      .onConflictDoUpdate({
        target: [divisionGrantsTable.divisionId, divisionGrantsTable.userId],
        set: { role },
      })
      .returning();
    return { grant: row };
  });

  if ("error" in outcome) {
    res.status(404).json({
      error: outcome.error === "division" ? "Division not found" : "That user is not a member of this organisation.",
    });
    return;
  }

  logger.info({ divisionId, role, route: "POST /divisions/:id/grants" }, "division grant written");
  res.status(201).json(outcome.grant);
});

/** DELETE /api/divisions/:id/grants/:userId */
router.delete("/divisions/:id/grants/:userId", async (req, res): Promise<void> => {
  const divisionId = parseId(req.params.id);
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  if (divisionId === null || typeof userId !== "string" || userId.length === 0) {
    res.status(400).json({ error: "Invalid division ID or user ID" });
    return;
  }

  const removed = await withOrg(orgContextFor(req), async (tx) => {
    const [row] = await tx
      .delete(divisionGrantsTable)
      .where(and(eq(divisionGrantsTable.divisionId, divisionId), eq(divisionGrantsTable.userId, userId)))
      .returning();
    return row ?? null;
  });

  if (!removed) {
    res.status(404).json({ error: "Grant not found" });
    return;
  }
  res.status(204).end();
});

/**
 * GET /api/organization/members — who is in this tenant, at what role, with
 * which division grants. Admin-only: a membership list names every colleague
 * and what each may do.
 */
router.get("/organization/members", async (req, res): Promise<void> => {
  const members = await withOrg(orgContextFor(req), async (tx) => {
    const rows = await tx.select().from(organizationMembersTable);
    const grants = await tx.select().from(divisionGrantsTable);

    return rows.map((row) => ({
      userId: row.userId,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
      divisionGrants: grants
        .filter((grant) => grant.userId === row.userId)
        .map((grant) => ({ divisionId: grant.divisionId, role: grant.role })),
    }));
  });

  res.json({ members, roles: ORG_ROLE_VALUES });
});

/**
 * PATCH /api/organization/members/:userId — change somebody's organisation role.
 *
 * Refuses to remove the last owner. An organisation with no owner has nobody
 * who can delete it or transfer it, which is a state no support call can
 * resolve — and the mistake is one keystroke away when an admin demotes
 * themselves.
 */
router.patch("/organization/members/:userId", async (req, res): Promise<void> => {
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const { role } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof userId !== "string" || userId.length === 0) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }
  if (typeof role !== "string" || !(ORG_ROLE_VALUES as readonly string[]).includes(role)) {
    res.status(400).json({ error: `\`role\` must be one of ${ORG_ROLE_VALUES.join(", ")}.` });
    return;
  }

  const outcome = await withOrg(orgContextFor(req), async (tx) => {
    const members = await tx.select().from(organizationMembersTable);
    const target = members.find((member) => member.userId === userId);
    if (!target) return { error: "not-found" as const };

    const owners = members.filter((member) => member.role === "owner");
    if (target.role === "owner" && role !== "owner" && owners.length === 1) {
      return { error: "last-owner" as const };
    }

    const [row] = await tx
      .update(organizationMembersTable)
      .set({ role })
      .where(eq(organizationMembersTable.userId, userId))
      .returning();
    return { member: row };
  });

  if ("error" in outcome) {
    if (outcome.error === "last-owner") {
      res.status(409).json({
        error:
          "This is the organisation's only owner. Make somebody else an owner first — an organisation with none has nobody who can transfer or delete it.",
      });
      return;
    }
    res.status(404).json({ error: "That user is not a member of this organisation." });
    return;
  }

  res.json(outcome.member);
});

export default router;
