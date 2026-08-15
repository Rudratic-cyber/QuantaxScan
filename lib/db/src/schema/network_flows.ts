import { pgTable, text, serial, integer, timestamp, check, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  NETWORK_FLOW_CRYPTO_STATE_VALUES,
  NETWORK_FLOW_RECORD_FORMAT_VALUES,
  NETWORK_FLOW_TRANSPORT_VALUES,
  type NetworkFlowCryptoState,
  type NetworkFlowRecordFormat,
  type NetworkFlowTransport,
} from "@workspace/collectors";
import { oneOf, nullableAtLeast } from "./sql-helpers";
import { organizationsTable } from "./organizations";
import { projectsTable } from "./projects";

/**
 * B11 — one **conversation** between two endpoints, as the customer's own
 * flow/session records described it.
 *
 * ## Why this is a table and not an `assets` row
 *
 * `assets` is the crypto inventory: one row is one piece of cryptography, and
 * `assets.algorithm` is `NOT NULL`. A conversation whose cryptography is
 * undetermined has nothing to put there — and inventing a sentinel algorithm
 * ("Unknown", "Undetermined") is exactly the guessed-value failure this surface
 * exists to refuse. Once a fabricated name is a row nothing distinguishes it
 * from a measured one, and it would flow into every algorithm rollup, every
 * chart and every compliance read as though it were an observation.
 *
 * The second reason is structural: `assets.location` is a single `NOT NULL`
 * column and cannot name two endpoints. The customer's stated goal is to see,
 * for every conversation, the cryptography protecting it **and both ends of
 * it** — so the pair needs somewhere to live that is shaped like a pair.
 *
 * So the two facts are stored in the two places that can hold them honestly:
 *
 *  - **This table** — every conversation, both endpoints, whether or not
 *    anything named its cryptography. `cryptoState = 'undetermined'` is a real
 *    inventory entry meaning "we saw this conversation and do not know what
 *    protected it", which is a useful thing for a CISO to be able to count.
 *  - **`assets` on the `network-flow` surface** — the cryptography itself,
 *    fingerprinted at the destination *service* endpoint, created only when a
 *    record actually named a cipher suite. See `fingerprint.ts`'s
 *    `network-flow` variant for why the source endpoint is deliberately not in
 *    that identity.
 *
 * ## What is deliberately not stored
 *
 * **The source port.** It is ephemeral — a new one per TCP connection — so
 * keying anything on it would mint a new row per handshake and fill the
 * inventory with garbage inside a day. It is accepted at the API boundary (so a
 * caller can submit a raw record unchanged) and discarded there. Byte and
 * packet counts are likewise absent: they describe one export window, not the
 * conversation, and this product has no use for traffic volume.
 */

export const networkFlowsTable = pgTable(
  "network_flows",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /**
     * The project the flow export was submitted under. A real foreign key,
     * unlike `assets`'s `project:<id>:` location prefix, because this table is
     * new and has no legacy convention to preserve — and it makes
     * `DELETE /projects/:id` reconcile by cascade rather than by string prefix.
     * A foreign key is NOT subject to RLS, so the route still has to confirm
     * the parent is visible inside the scope before writing.
     */
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    /** Deterministic identity — `networkFlowKey()` in `@workspace/collectors`. Hashed, so a delimiter inside a hostname cannot collide two conversations. */
    flowKey: text("flow_key").notNull(),

    // ── Both ends of the conversation ───────────────────────────────────────
    /** The string the near end's identity resolved to: workload, else hostname, else address. Part of `flowKey`. */
    sourceIdentity: text("source_identity").notNull(),
    sourceAddress: text("source_address"),
    sourceHostname: text("source_hostname"),
    sourceWorkload: text("source_workload"),
    /** The far end's identity, same resolution order. Part of `flowKey`, and the string the asset fingerprint was computed from. */
    destinationIdentity: text("destination_identity").notNull(),
    destinationAddress: text("destination_address"),
    destinationHostname: text("destination_hostname"),
    destinationWorkload: text("destination_workload"),
    destinationPort: integer("destination_port").notNull(),
    transport: text("transport").notNull().$type<NetworkFlowTransport>(),
    /** The record's own application-protocol field (`https`, `h2`, `grpc`). Null = the record did not say. Never derived from the port. */
    applicationProtocol: text("application_protocol"),

    // ── What, if anything, is known about the cryptography ──────────────────
    /**
     * `'undetermined'` means the evidence did not state the cryptography. It is
     * NOT "unencrypted" — no flow record this product reads can make that claim,
     * and collapsing the two would turn a gap into a finding.
     */
    cryptoState: text("crypto_state").notNull().$type<NetworkFlowCryptoState>(),
    /** The suite name verbatim, as the record wrote it. Null when no record for this conversation named one. */
    reportedCipherSuite: text("reported_cipher_suite"),
    /** e.g. `"TLSv1.2"`. Null = not stated. A version alone never produces an asset — it is not an algorithm. */
    reportedTlsVersion: text("reported_tls_version"),
    /**
     * When a record naming a cipher was last ingested for this conversation.
     * Null while `cryptoState` is `undetermined`. Carried so a stale suite is
     * visible as stale: a later cipher-free export deliberately does not blank
     * `reportedCipherSuite` (silence is not a denial), so the only honest way to
     * show age is to show when the statement was made.
     */
    cryptoReportedAt: timestamp("crypto_reported_at", { withTimezone: true }),
    /** Which kind of export the evidence came from. Not part of identity: one conversation legitimately appears in two formats. */
    recordFormat: text("record_format").notNull().$type<NetworkFlowRecordFormat>(),

    /** How many raw records have collapsed into this conversation, across every submission. */
    recordCount: integer("record_count").notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique per organisation, not globally: two organisations legitimately run
    // the same private address ranges and the same service names.
    uniqueIndex("network_flows_org_flow_key_idx").on(table.organizationId, table.flowKey),
    index("network_flows_org_project_idx").on(table.organizationId, table.projectId),
    // Supports "which conversations reach this service endpoint?", which is how
    // the read route joins a conversation to the crypto assets at its far end.
    index("network_flows_org_destination_idx").on(
      table.organizationId,
      table.destinationIdentity,
      table.destinationPort,
    ),
    check("network_flows_transport_check", oneOf(table.transport, NETWORK_FLOW_TRANSPORT_VALUES)),
    check("network_flows_crypto_state_check", oneOf(table.cryptoState, NETWORK_FLOW_CRYPTO_STATE_VALUES)),
    check("network_flows_record_format_check", oneOf(table.recordFormat, NETWORK_FLOW_RECORD_FORMAT_VALUES)),
    // Port 0 is reserved and never a service endpoint; the collector rejects a
    // record carrying one long before here.
    check("network_flows_destination_port_check", nullableAtLeast(table.destinationPort, 1)),
    check("network_flows_record_count_check", nullableAtLeast(table.recordCount, 1)),
  ],
);

export const insertNetworkFlowSchema = createInsertSchema(networkFlowsTable).omit({
  id: true,
  firstSeen: true,
  lastSeen: true,
});
export type InsertNetworkFlow = z.infer<typeof insertNetworkFlowSchema>;
export type NetworkFlow = typeof networkFlowsTable.$inferSelect;
