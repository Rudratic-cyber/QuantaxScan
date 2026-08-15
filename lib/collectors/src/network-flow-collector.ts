import { createHash } from "node:crypto";
import { parseCipherSuite, type CipherSuiteGapReason, type CipherSuiteRole } from "./cipher-suite";
import type {
  NetworkFlowCryptoState,
  NetworkFlowLocationDetail,
  NetworkFlowRecordFormat,
  NetworkFlowTransport,
  NetworkLocationDetail,
} from "./location-detail";
import type { RawObservation } from "./types";

/**
 * B11 — the `network-flow` surface: **conversations between endpoints**, and
 * the cryptography (if any) that the customer's own records say protected them.
 *
 * ## What this is, and the roadmap constraint it is built around
 *
 * `docs/Claude/02-roadmap.md` lists "real-time network traffic interception" as
 * an explicit twelve-month **non-goal**, with "passive scanning only" as the
 * stated posture. So this surface does no packet capture and installs no tap.
 * It ingests **flow and session records the customer's infrastructure already
 * produces**: a VPC flow log, a load-balancer access log, a service-mesh
 * telemetry export, a firewall session log. Those exist in every enterprise
 * already, they name both ends of every conversation, and reading them requires
 * no interception by us.
 *
 * ## The honesty case, which is the whole point of the surface
 *
 * A flow log proves two endpoints talked. It usually does **not** prove what
 * cryptography protected the conversation — a VPC flow log carries five-tuple
 * and byte counts and no cipher at all. That case is recorded as a conversation
 * whose cryptography is **undetermined**, and the one thing it must never
 * become is a guess:
 *
 *   **Port 443 is not evidence of TLS 1.3.** It is not evidence of TLS. It is
 *   evidence that something listened on 443. Nothing in this module reads the
 *   port to decide what protects the traffic, and
 *   `network-flow-collector.test.ts` asserts it.
 *
 * "We saw this conversation and do not know its cryptography" is a genuinely
 * useful inventory entry — it names an unexamined piece of the estate, which is
 * the same fact the D3 coverage meter exists to state. A guessed cipher is
 * worse than nothing, because once it is a row nothing distinguishes it from a
 * measured one.
 *
 * ## Identity: what makes a conversation survive re-observation
 *
 * Two different identities, deliberately, because two different things are
 * being identified.
 *
 * **The conversation** (`networkFlowKey`) is
 * `transport + source identity + destination identity + destination port`.
 * The **source port is not in it, and is not stored at all**. An ephemeral
 * source port changes on every connection; keying on it would mint a new
 * conversation per TCP handshake and fill the inventory with garbage inside a
 * day. Nor is a timestamp, a byte count or a packet count — those are what one
 * *record* says, not what the conversation *is*. An endpoint's identity is its
 * workload/service name if the record carries one, else its hostname, else its
 * address; preferring the workload name is what keeps a service-mesh
 * conversation stable across a redeploy that renumbers every pod IP.
 *
 * **The cryptography** is fingerprinted at the **destination service
 * endpoint** — `transport + destination + destination port + role +
 * algorithm` — and the source is deliberately absent from it. The cryptography
 * protecting a conversation is a property of the service being dialled (its TLS
 * configuration), not of which client dialled it. Five hundred clients talking
 * to one load balancer are five hundred conversations and **one** set of crypto
 * assets. Putting the source in the asset identity would reproduce the
 * ephemeral-port failure one level up, on the slower clock of DHCP leases and
 * pod IPs.
 *
 * `location` is the slot `<repo>:netflow:<transport>:<destination>:<port>:<role>`
 * and deliberately excludes the algorithm, exactly as B7's data-at-rest
 * location does: a service that moves off RSA reads as the RSA asset going
 * `gone` at that slot and a new one appearing, which is what a migration
 * actually is.
 */

/**
 * The vocabulary this collector reads (`NETWORK_FLOW_RECORD_FORMAT_VALUES`,
 * `..._TRANSPORT_VALUES`, `..._CRYPTO_STATE_VALUES`) lives in
 * `location-detail.ts`, next to the zod schema that validates it at the
 * persistence boundary — one definition, one direction of dependency, the same
 * arrangement B7 uses.
 */

/** One end of a conversation, as the record described it. Every field is optional because every format carries a different subset. */
export interface NetworkFlowEndpointInput {
  /** IP address, v4 or v6, verbatim. */
  address?: string | null;
  hostname?: string | null;
  /** Service/workload name — what a mesh telemetry export calls the peer. Preferred as the identity because it survives renumbering. */
  workload?: string | null;
  /**
   * Port. Meaningful on the destination (it is the service) and ephemeral on
   * the source (it is one connection). Accepted on both so a caller can submit
   * a raw record unchanged; the source port is then **discarded** — see
   * `endpointIdentity`.
   */
  port?: number | null;
}

/** One flow/session record, as the customer's infrastructure wrote it. */
export interface NetworkFlowRecordInput {
  source: NetworkFlowEndpointInput;
  /** Must resolve to an identity *and* carry a port — without those there is no service endpoint to attribute cryptography to. */
  destination: NetworkFlowEndpointInput;
  transport?: NetworkFlowTransport;
  /** e.g. `"https"`, `"h2"`, `"grpc"` — the record's own application-protocol field. Never derived from the port. */
  applicationProtocol?: string | null;
  recordFormat?: NetworkFlowRecordFormat;
  /** e.g. `"TLSv1.2"`, `"TLSv1.3"`. Recorded as evidence; on its own it produces no observation — a version is not an algorithm. */
  tlsVersion?: string | null;
  /** The negotiated suite, e.g. `"ECDHE-RSA-AES128-GCM-SHA256"`. Absent in most flow-log formats, and that absence is the case this surface exists for. */
  cipherSuite?: string | null;
  /** How many raw records this row stands for, when the caller has already aggregated. Absent = one. */
  recordCount?: number | null;
  /** ISO 8601, the record's own timestamp. Evidence only — never identity. */
  observedAt?: string | null;
}

/** Why a record produced no cryptographic observation. Reported to the caller, never inferred away. */
export type NetworkFlowGapReason =
  /** The record named no cipher suite. The ordinary case for a VPC flow log or a firewall session log. */
  | "cipher-suite-not-reported"
  /** A cipher suite was named but nothing in it could be parsed as a suite name. */
  | "cipher-suite-not-recognised"
  /** A suite name was parsed but one of its components is not stated or not resolvable — carries the parser's own reason. */
  | "cipher-suite-component-not-resolved";

export interface NetworkFlowGap {
  reason: NetworkFlowGapReason;
  /** The parser's reason, when `reason` is `cipher-suite-component-not-resolved`. */
  component?: CipherSuiteGapReason;
  /** The string the caller supplied, when there was one. */
  reported?: string;
}

/** Why a record was not turned into a conversation at all. A rejected record is reported back, never silently dropped. */
export type NetworkFlowRejectionReason =
  /** No workload, hostname or address on the destination — there is nothing to identify the far end by. */
  | "destination-not-identified"
  /** No destination port, or one outside 1–65535. Without it there is no service endpoint. */
  | "destination-port-missing"
  /** No workload, hostname or address on the source — "something talked to X" is not a conversation. */
  | "source-not-identified";

export interface NetworkFlowRejection {
  reason: NetworkFlowRejectionReason;
  /** Index of the record in the submitted array, so a caller can find it again. */
  index: number;
}

/** One conversation, after every record naming it has been collapsed together. */
export interface NetworkFlowConversation {
  /** Deterministic identity — see `networkFlowKey`. */
  flowKey: string;
  transport: NetworkFlowTransport;
  source: NetworkFlowEndpointInput;
  destination: NetworkFlowEndpointInput;
  /** The identity string each end resolved to. Stored so a reader can see which field was used. */
  sourceIdentity: string;
  destinationIdentity: string;
  destinationPort: number;
  applicationProtocol: string | null;
  recordFormat: NetworkFlowRecordFormat;
  cryptoState: NetworkFlowCryptoState;
  /** Verbatim, as the record wrote it. Null when no record for this conversation named one. */
  reportedCipherSuite: string | null;
  reportedTlsVersion: string | null;
  /** How many raw records collapsed into this conversation. */
  recordCount: number;
  /** The `location` slots this conversation's cryptography was recorded at. Empty when `cryptoState` is `undetermined`. */
  locations: string[];
  observations: RawObservation[];
  gaps: NetworkFlowGap[];
}

export interface NetworkFlowCollectionResult {
  conversations: NetworkFlowConversation[];
  rejected: NetworkFlowRejection[];
  /**
   * The `location` slots this submission is entitled to reconcile — see the
   * rule in `collectNetworkFlowObservations`. **Only slots where a cipher was
   * actually named appear here.**
   */
  reobservedLocations: string[];
}

/**
 * Confidence (docs/Claude/09-open-gaps.md G-11): **0.8**.
 *
 * Placed by argument, not by feel. The evidence is a record of a session that
 * genuinely completed, written by the infrastructure that terminated it — so it
 * is stronger than B6's protocol *configuration* (0.7-ish tier: what an endpoint
 * would accept) and stronger than B7's `configuration-report` (0.6: what a
 * setting says, with nothing proving the data was written under it). It is
 * weaker than B3's completed handshake (1.0) for one specific reason: **we did
 * not do the handshake**. We are reading somebody else's log, we cannot re-run
 * it, and a mis-configured log pipeline or a truncated field is invisible to us.
 * One number below the top tier is the honest position for "a real session,
 * observed by someone else".
 */
export const NETWORK_FLOW_CONFIDENCE = 0.8;

export const DEFAULT_NETWORK_FLOW_TRANSPORT: NetworkFlowTransport = "tcp";
export const DEFAULT_NETWORK_FLOW_RECORD_FORMAT: NetworkFlowRecordFormat = "other";

/** Every canonical name this collector can emit — the guard in `algorithm-mapping.test.ts` iterates it. */
export { CIPHER_SUITE_ALGORITHMS as NETWORK_FLOW_ALGORITHMS } from "./cipher-suite";

function clean(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The stable identifier for one end of a conversation.
 *
 * Preference order — workload, hostname, address — is the order of decreasing
 * stability, not of decreasing precision. A pod IP is *more* precise than a
 * service name and far less stable, and stability is what an asset identity
 * needs: a redeploy that renumbers every pod must not orphan and recreate the
 * whole inventory.
 *
 * The port is not part of this, on either end. On the source it is ephemeral;
 * on the destination it is carried separately because it is part of the
 * conversation's identity in its own right.
 */
export function endpointIdentity(endpoint: NetworkFlowEndpointInput): string | undefined {
  return clean(endpoint.workload) ?? clean(endpoint.hostname) ?? clean(endpoint.address);
}

/**
 * Deterministic identity for a conversation.
 *
 * Hashed over a JSON-encoded ordered array rather than a delimiter-joined
 * string, for the reason `computeFingerprint` gives: a hostname or workload
 * name containing the delimiter must not be able to collide two distinct
 * conversations.
 */
export function networkFlowKey(input: {
  repo: string;
  transport: NetworkFlowTransport;
  sourceIdentity: string;
  destinationIdentity: string;
  destinationPort: number;
}): string {
  const fields = [
    "network-flow",
    input.repo,
    input.transport,
    input.sourceIdentity,
    input.destinationIdentity,
    String(input.destinationPort),
  ];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** `<repo>:netflow:<transport>:<destination>:<port>:<role>` — a stable slot, deliberately without the algorithm in it. See the header. */
export function networkFlowLocation(
  repo: string,
  transport: NetworkFlowTransport,
  destinationIdentity: string,
  destinationPort: number,
  role: CipherSuiteRole,
): string {
  return `${repo}:netflow:${transport}:${destinationIdentity}:${destinationPort}:${role}`;
}

/**
 * SP 1800-38B §4.1.4.1 Table 6's seven data elements, filled in from one end of
 * a conversation. The existing `network` profile is reused verbatim for both
 * ends rather than a second network profile being invented — Table 6 describes
 * *where on the wire* something was observed, and a conversation has two such
 * places.
 *
 * `destinationPort` is set only for the destination end. Table 6 defines a
 * "Destination port" element and no source-port element, and the source port is
 * the ephemeral value this surface most needs to keep out of its data.
 */
function endpointDetail(
  endpoint: NetworkFlowEndpointInput,
  options: { port?: number; applicationProtocol?: string },
): NetworkLocationDetail {
  const address = clean(endpoint.address);
  const hostname = clean(endpoint.hostname);
  return {
    ...(address !== undefined ? { ipAddresses: [address] } : {}),
    ...(hostname !== undefined ? { hostname } : {}),
    ...(options.port !== undefined ? { destinationPort: options.port } : {}),
    ...(options.applicationProtocol !== undefined
      ? {
          // `other`, not `iana-service-name`: the record's field is free text
          // and this collector has no IANA service-name registry to validate it
          // against. Claiming the stricter kind would be asserting a validation
          // that never happened.
          applicationLayerProtocol: { kind: "other" as const, value: options.applicationProtocol },
        }
      : {}),
  };
}

interface PendingConversation extends NetworkFlowConversation {
  /** The record that supplied the cipher suite, so a later cipher-free record cannot blank it. */
  cipherFromIndex: number | null;
}

/**
 * Turn a submission of flow records into conversations, observations and the
 * slots the submission may reconcile.
 *
 * ## The reobservation rule, and why it is the sharpest edge here
 *
 * A conversation whose cryptography is **undetermined puts nothing into
 * `reobservedLocations`**. This is B7's "encrypted, cipher not reported → not
 * in scope" rule, transplanted, and here it protects against a failure that
 * would run *on a schedule*: a nightly VPC-flow-log export names no cipher for
 * any row, so if an undetermined conversation put its destination slot in
 * scope, every asset a load-balancer access log had established would be marked
 * `gone` the first night the VPC export ran. Mass silent false remediation,
 * with no remediation anywhere near it. A record that does not state the
 * cryptography has not observed the cryptography.
 *
 * The scope is exact locations, never a `<repo>:netflow:` prefix family. A flow
 * export is partial by construction — one time window, one VPC, one mesh
 * namespace, one firewall — which is `ingestKmsObservations`'s pagination
 * argument verbatim. The consequence, stated rather than hidden: a service that
 * genuinely stops accepting connections is never inferred as `gone` from its
 * absence in a later export. Absence is not evidence.
 */
export function collectNetworkFlowObservations(
  repo: string,
  records: NetworkFlowRecordInput[],
): NetworkFlowCollectionResult {
  const byFlowKey = new Map<string, PendingConversation>();
  const order: PendingConversation[] = [];
  const rejected: NetworkFlowRejection[] = [];

  records.forEach((record, index) => {
    const destinationIdentity = endpointIdentity(record.destination);
    const sourceIdentity = endpointIdentity(record.source);
    const destinationPort = record.destination.port;

    if (destinationIdentity === undefined) {
      rejected.push({ reason: "destination-not-identified", index });
      return;
    }
    if (sourceIdentity === undefined) {
      rejected.push({ reason: "source-not-identified", index });
      return;
    }
    if (destinationPort == null || !Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
      rejected.push({ reason: "destination-port-missing", index });
      return;
    }

    const transport = record.transport ?? DEFAULT_NETWORK_FLOW_TRANSPORT;
    const flowKey = networkFlowKey({ repo, transport, sourceIdentity, destinationIdentity, destinationPort });
    const recordCount = record.recordCount != null && record.recordCount > 0 ? Math.trunc(record.recordCount) : 1;

    let held = byFlowKey.get(flowKey);
    if (held === undefined) {
      held = {
        flowKey,
        transport,
        // The source port is dropped here and nowhere reinstated: it is the
        // one field on a flow record that changes on every connection.
        source: { address: clean(record.source.address), hostname: clean(record.source.hostname), workload: clean(record.source.workload) },
        destination: {
          address: clean(record.destination.address),
          hostname: clean(record.destination.hostname),
          workload: clean(record.destination.workload),
          port: destinationPort,
        },
        sourceIdentity,
        destinationIdentity,
        destinationPort,
        applicationProtocol: clean(record.applicationProtocol) ?? null,
        recordFormat: record.recordFormat ?? DEFAULT_NETWORK_FLOW_RECORD_FORMAT,
        cryptoState: "undetermined",
        reportedCipherSuite: null,
        reportedTlsVersion: null,
        recordCount: 0,
        locations: [],
        observations: [],
        gaps: [],
        cipherFromIndex: null,
      };
      byFlowKey.set(flowKey, held);
      order.push(held);
    }

    held.recordCount += recordCount;
    held.applicationProtocol ??= clean(record.applicationProtocol) ?? null;

    const cipherSuite = clean(record.cipherSuite);
    if (cipherSuite === undefined) {
      // Nothing to record, and — critically — nothing that would let this
      // record retract what another record already stated. A silent field is
      // silence, not a denial.
      return;
    }

    // A later record naming a cipher wins over an earlier one: it is the more
    // recent statement about the same conversation. A record naming *no*
    // cipher never wins, per the paragraph above.
    held.reportedCipherSuite = cipherSuite;
    held.reportedTlsVersion = clean(record.tlsVersion) ?? held.reportedTlsVersion;
    held.cipherFromIndex = index;
    held.recordFormat = record.recordFormat ?? held.recordFormat;
  });

  const reobservedLocations: string[] = [];

  for (const conversation of order) {
    if (conversation.reportedCipherSuite === null) {
      conversation.gaps.push({ reason: "cipher-suite-not-reported" });
      continue;
    }

    const parsed = parseCipherSuite(conversation.reportedCipherSuite);
    if (parsed === undefined) {
      conversation.gaps.push({ reason: "cipher-suite-not-recognised", reported: conversation.reportedCipherSuite });
      continue;
    }

    for (const gap of parsed.gaps) {
      conversation.gaps.push({
        reason: "cipher-suite-component-not-resolved",
        component: gap,
        reported: conversation.reportedCipherSuite,
      });
    }

    if (parsed.components.length === 0) {
      // Parsed, understood, and it names nothing this product can record. The
      // conversation stays `undetermined` and its slots stay out of scope.
      continue;
    }

    conversation.cryptoState = "observed";

    for (const component of parsed.components) {
      const location = networkFlowLocation(
        repo,
        conversation.transport,
        conversation.destinationIdentity,
        conversation.destinationPort,
        component.role,
      );
      const detail: NetworkFlowLocationDetail = {
        destinationIdentity: conversation.destinationIdentity,
        sourceIdentity: conversation.sourceIdentity,
        transport: conversation.transport,
        role: component.role,
        cryptoState: "observed",
        recordFormat: conversation.recordFormat,
        reportedCipherSuite: conversation.reportedCipherSuite,
        reportedTlsVersion: conversation.reportedTlsVersion ?? undefined,
        reportedComponentToken: component.token,
        destination: endpointDetail(conversation.destination, {
          port: conversation.destinationPort,
          applicationProtocol: conversation.applicationProtocol ?? undefined,
        }),
        source: endpointDetail(conversation.source, {}),
      };

      conversation.observations.push({
        algorithm: component.algorithm,
        // Only the bulk cipher ever carries one, and only because the suite
        // name states it. `ECDHE` names no group and `RSA` names no modulus
        // length, so those stay undetermined (G-05) rather than acquiring a
        // plausible default.
        keySize: component.keySize,
        location,
        locationDetail: { kind: "network-flow", networkFlow: detail },
        discoveryModality: "passive_network_observation",
        confidence: NETWORK_FLOW_CONFIDENCE,
        evidence: {
          transport: conversation.transport,
          sourceIdentity: conversation.sourceIdentity,
          destinationIdentity: conversation.destinationIdentity,
          destinationPort: conversation.destinationPort,
          applicationProtocol: conversation.applicationProtocol,
          recordFormat: conversation.recordFormat,
          reportedCipherSuite: conversation.reportedCipherSuite,
          reportedTlsVersion: conversation.reportedTlsVersion,
          cipherSuiteNameForm: parsed.form,
          cipherSuiteTokens: parsed.tokens,
          role: component.role,
          matchedToken: component.token,
          recordCount: conversation.recordCount,
          note:
            "Read from a flow/session record the customer's own infrastructure produced. This product " +
            "initiated no connection and captured no packets — the negotiated parameters are as the record " +
            "stated them, not as we measured them.",
        },
      });
      conversation.locations.push(location);
      reobservedLocations.push(location);
    }
  }

  return {
    conversations: order.map(({ cipherFromIndex: _cipherFromIndex, ...conversation }) => conversation),
    rejected,
    reobservedLocations: [...new Set(reobservedLocations)],
  };
}
