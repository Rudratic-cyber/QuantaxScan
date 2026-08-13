import { check, index, integer, pgTable, text, timestamp, jsonb, varchar } from "drizzle-orm/pg-core";
import { REPORT_VISIBILITY_VALUES } from "./auth-enums";
import { oneOf } from "./sql-helpers";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";

/**
 * Share links. docs/Claude/13-auth-and-tenancy.md §4.4.
 *
 * **`owner` is not a user.** It is the GitHub repository owner — see
 * `routes/reports.ts`, which destructures `{ owner, repo, repoUrl, data }`
 * from the request body. The person is `createdByUserId`. Do not conflate
 * them.
 *
 * This table's policy carries the public-share rule itself
 * (`visibility = 'public' AND revoked_at IS NULL AND expires_at > now()`),
 * so the anonymous share-link route goes *through* the isolation choke point
 * rather than around it.
 *
 * The columns for expiry, revocation and access logging land here in P1 with
 * the rest of the migration; the UI that sets and shows them is P4.
 */
export const sharedReportsTable = pgTable(
  "shared_reports",
  {
    id: text("id").primaryKey(),
    /** The tenant that owns the report. NOT the GitHub owner below. */
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** The GitHub repository owner, from the request body. Legacy name, kept. */
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    repoUrl: text("repo_url").notNull(),
    data: jsonb("data").notNull(),
    /** Who created it. Null for rows created by the shared API key, which has no person behind it. */
    createdByUserId: varchar("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    visibility: text("visibility").notNull().default("private"),
    /** NOT NULL: a share link with no expiry is the S2 finding. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("shared_reports_org_idx").on(table.organizationId),
    check("shared_reports_visibility_check", oneOf(table.visibility, REPORT_VISIBILITY_VALUES)),
  ],
);

export type SharedReport = typeof sharedReportsTable.$inferSelect;
