import { pgTable, text, serial, timestamp, integer, index, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { oneOf, nullableAtLeast } from "./sql-helpers";
import { DATA_CLASSIFICATION_VALUES, type DataClassification } from "../classification";
import { organizationsTable } from "./organizations";
import { divisionsTable } from "./divisions";

export const projectsTable = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    /** The tenant. Enforced by RLS in the database, not by a `where` clause in a route — see lib/db/sql/tenant-isolation.sql. */
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /**
     * RBAC — the division this project belongs to, or NULL for organisation-wide.
     * docs/Claude/15-rbac-design.md §2. Nullable with no default on purpose:
     * every project that predates divisions stays visible to the whole tenant,
     * so this ships without a flag day.
     *
     * This is the **authoritative** copy — the `division_id` on `assets`,
     * `findings` and the rest is denormalised from it (§4.3), which is why
     * only this one carries a foreign key. `ON DELETE SET NULL`, because
     * deleting a division must not delete the projects inside it: they become
     * organisation-wide, which is the state they were in before divisions
     * existed and the only safe reading of "the team was dissolved".
     */
    divisionId: integer("division_id").references(() => divisionsTable.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    language: text("language").notNull(),
    riskScore: integer("risk_score"),
    lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    totalScans: integer("total_scans").notNull().default(0),
    criticalCount: integer("critical_count").notNull().default(0),
    alertCount: integer("alert_count").notNull().default(0),
    cleanCount: integer("clean_count").notNull().default(0),

    /**
     * A3 — the project-level default every asset in this project inherits
     * unless it overrides it. docs/Claude/03-features.md §A3.
     *
     * **Nullable, with no database default, on purpose.** Null means the
     * project sets no default, which is not the same as a human choosing
     * `internal`: only the first of those may be reported as an assumption.
     * A `NOT NULL DEFAULT 'internal'` here would make A3's acceptance criterion
     * — "the default clearly marked as an assumption in reports" — impossible
     * to satisfy, because the information would be destroyed on write.
     *
     * Assets are associated with a project by the `project:<id>:` prefix on
     * `assets.location` (`projectRepoId()`), not by a foreign key. Resolution
     * is `resolveSecrecyLifetime()` in `src/classification.ts`.
     */
    dataClassification: text("data_classification").$type<DataClassification>(),
    /** A3 — the project-level X override, in years, independent of the label. Null = not set. */
    secrecyLifetimeYears: integer("secrecy_lifetime_years"),
  },
  (table) => [
    index("projects_org_idx").on(table.organizationId),
    check("projects_data_classification_check", oneOf(table.dataClassification, DATA_CLASSIFICATION_VALUES)),
    check("projects_secrecy_lifetime_years_check", nullableAtLeast(table.secrecyLifetimeYears, 0)),
  ],
);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
