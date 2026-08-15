import { describe, expect, it } from "vitest";
import {
  collectNetworkFlowObservations,
  endpointIdentity,
  networkFlowKey,
  networkFlowLocation,
  NETWORK_FLOW_CONFIDENCE,
  type NetworkFlowRecordInput,
} from "./network-flow-collector";
import { computeFingerprint, fingerprintForObservation } from "./fingerprint";
import { LocationDetailSchema } from "./location-detail";

const REPO = "project:7";

function record(overrides: Partial<NetworkFlowRecordInput> = {}): NetworkFlowRecordInput {
  return {
    source: { address: "10.0.1.15" },
    destination: { address: "10.0.9.4", hostname: "payments.internal", port: 443 },
    transport: "tcp",
    ...overrides,
  };
}

describe("collectNetworkFlowObservations — the conversation", () => {
  it("records a conversation with both endpoints even when nothing names its cryptography", () => {
    // The case this surface exists for: a VPC flow log proves two endpoints
    // talked and says nothing about what protected the traffic.
    const { conversations, reobservedLocations } = collectNetworkFlowObservations(REPO, [
      record({ recordFormat: "vpc-flow-log" }),
    ]);

    expect(conversations).toHaveLength(1);
    const [flow] = conversations;
    expect(flow.sourceIdentity).toBe("10.0.1.15");
    expect(flow.destinationIdentity).toBe("payments.internal");
    expect(flow.destinationPort).toBe(443);
    expect(flow.cryptoState).toBe("undetermined");
    expect(flow.reportedCipherSuite).toBeNull();
    expect(flow.observations).toEqual([]);
    expect(flow.gaps).toEqual([{ reason: "cipher-suite-not-reported" }]);
    // And — the rule that keeps a nightly cipher-free export from marking every
    // asset gone — it reconciles nothing.
    expect(reobservedLocations).toEqual([]);
  });

  it("collapses fifty connections from fifty ephemeral source ports into ONE conversation", () => {
    // Brief item 5's acceptance test. An ephemeral source port must not mint a
    // new asset — or a new conversation — on every connection.
    const records = Array.from({ length: 50 }, (_, i) =>
      record({ source: { address: "10.0.1.15", port: 30000 + i } }),
    );
    const { conversations } = collectNetworkFlowObservations(REPO, records);

    expect(conversations).toHaveLength(1);
    expect(conversations[0].recordCount).toBe(50);
    // The port is not merely absent from the identity — it is not stored.
    expect(conversations[0].source.port).toBeUndefined();
    expect(JSON.stringify(conversations[0])).not.toContain("30000");
  });

  it("prefers a workload name over an address, so a pod renumbering does not orphan the conversation", () => {
    const before = collectNetworkFlowObservations(REPO, [
      record({
        source: { workload: "checkout", address: "10.244.1.7" },
        destination: { workload: "payments", address: "10.244.2.9", port: 8443 },
        recordFormat: "service-mesh-telemetry",
      }),
    ]);
    const after = collectNetworkFlowObservations(REPO, [
      record({
        source: { workload: "checkout", address: "10.244.5.31" },
        destination: { workload: "payments", address: "10.244.6.88", port: 8443 },
        recordFormat: "service-mesh-telemetry",
      }),
    ]);

    expect(before.conversations[0].flowKey).toBe(after.conversations[0].flowKey);
    expect(endpointIdentity({ workload: "payments", hostname: "p.svc", address: "1.2.3.4" })).toBe("payments");
    expect(endpointIdentity({ hostname: "p.svc", address: "1.2.3.4" })).toBe("p.svc");
    expect(endpointIdentity({ address: "1.2.3.4" })).toBe("1.2.3.4");
    expect(endpointIdentity({})).toBeUndefined();
  });

  it("keeps the same host pair on tcp and udp as two conversations", () => {
    const { conversations } = collectNetworkFlowObservations(REPO, [
      record({ transport: "tcp" }),
      record({ transport: "udp" }),
    ]);
    expect(conversations).toHaveLength(2);
  });

  it("rejects a record it cannot place, and says which one and why", () => {
    const { conversations, rejected } = collectNetworkFlowObservations(REPO, [
      record({ destination: { port: 443 } }),
      record({ source: {} }),
      record({ destination: { hostname: "a.internal" } }),
      record({ destination: { hostname: "a.internal", port: 70000 } }),
    ]);
    expect(conversations).toEqual([]);
    expect(rejected).toEqual([
      { reason: "destination-not-identified", index: 0 },
      { reason: "source-not-identified", index: 1 },
      { reason: "destination-port-missing", index: 2 },
      { reason: "destination-port-missing", index: 3 },
    ]);
  });

  it("hashes the flow key over an ordered array, so a delimiter in a name cannot collide two conversations", () => {
    const a = networkFlowKey({
      repo: REPO,
      transport: "tcp",
      sourceIdentity: "a:b",
      destinationIdentity: "c",
      destinationPort: 443,
    });
    const b = networkFlowKey({
      repo: REPO,
      transport: "tcp",
      sourceIdentity: "a",
      destinationIdentity: "b:c",
      destinationPort: 443,
    });
    expect(a).not.toBe(b);
  });
});

describe("collectNetworkFlowObservations — the cryptography", () => {
  const withCipher = record({
    recordFormat: "load-balancer-access-log",
    tlsVersion: "TLSv1.2",
    cipherSuite: "ECDHE-RSA-AES128-GCM-SHA256",
  });

  it("records the three components a TLS 1.2 suite name states, at three role slots", () => {
    const { conversations, reobservedLocations } = collectNetworkFlowObservations(REPO, [withCipher]);
    const [flow] = conversations;

    expect(flow.cryptoState).toBe("observed");
    expect(flow.observations.map((o) => [o.algorithm, o.keySize ?? null])).toEqual([
      ["ECDH/DH", null],
      ["RSA", null],
      ["AES", 128],
    ]);
    expect(flow.observations.every((o) => o.confidence === NETWORK_FLOW_CONFIDENCE)).toBe(true);
    expect(flow.observations.every((o) => o.discoveryModality === "passive_network_observation")).toBe(true);
    expect(reobservedLocations).toEqual([
      networkFlowLocation(REPO, "tcp", "payments.internal", 443, "key-exchange"),
      networkFlowLocation(REPO, "tcp", "payments.internal", 443, "authentication"),
      networkFlowLocation(REPO, "tcp", "payments.internal", 443, "bulk-cipher"),
    ]);
  });

  it("carries no key size for the key exchange or the authentication — the name states none (G-05)", () => {
    const { conversations } = collectNetworkFlowObservations(REPO, [withCipher]);
    const byRole = new Map(
      conversations[0].observations.map((o) => [
        o.locationDetail?.kind === "network-flow" ? o.locationDetail.networkFlow.role : "?",
        o.keySize,
      ]),
    );
    expect(byRole.get("key-exchange")).toBeUndefined();
    expect(byRole.get("authentication")).toBeUndefined();
    expect(byRole.get("bulk-cipher")).toBe(128);
  });

  it("emits a locationDetail that validates, carrying Table 6's elements for BOTH ends", () => {
    const { conversations } = collectNetworkFlowObservations(REPO, [
      { ...withCipher, applicationProtocol: "h2" },
    ]);
    for (const observation of conversations[0].observations) {
      const parsed = LocationDetailSchema.safeParse(observation.locationDetail);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    const detail = conversations[0].observations[0].locationDetail;
    if (detail?.kind !== "network-flow") throw new Error("expected a network-flow locationDetail");
    expect(detail.networkFlow.destination.hostname).toBe("payments.internal");
    expect(detail.networkFlow.destination.destinationPort).toBe(443);
    expect(detail.networkFlow.destination.applicationLayerProtocol).toEqual({ kind: "other", value: "h2" });
    expect(detail.networkFlow.source.ipAddresses).toEqual(["10.0.1.15"]);
    // Table 6 defines no source-port element, and this is the field that must
    // never reach storage.
    expect(detail.networkFlow.source.destinationPort).toBeUndefined();
  });

  it("fingerprints to the network-flow surface, and never collides two roles that share an algorithm", () => {
    // `TLS_RSA_WITH_AES_256_CBC_SHA` names RSA as both the key exchange and the
    // authentication. Without `role` in the identity these two would be one
    // asset, and remediating one would look like remediating the other.
    const { conversations } = collectNetworkFlowObservations(REPO, [
      record({ cipherSuite: "TLS_RSA_WITH_AES_256_CBC_SHA" }),
    ]);
    const rsa = conversations[0].observations.filter((o) => o.algorithm === "RSA");
    expect(rsa).toHaveLength(2);

    const fingerprints = rsa.map((o) => {
      const input = fingerprintForObservation(o, { repo: REPO });
      expect(input?.surface).toBe("network-flow");
      return computeFingerprint(input!);
    });
    expect(new Set(fingerprints).size).toBe(2);
  });

  it("keeps one set of crypto assets when many clients talk to one service", () => {
    // The cryptography is a property of the service being dialled, not of who
    // dialled it. Five clients, five conversations, one slot per role.
    const clients = ["10.0.1.1", "10.0.1.2", "10.0.1.3", "10.0.1.4", "10.0.1.5"];
    const { conversations, reobservedLocations } = collectNetworkFlowObservations(
      REPO,
      clients.map((address) => ({ ...withCipher, source: { address } })),
    );
    expect(conversations).toHaveLength(5);
    expect(reobservedLocations).toHaveLength(3);

    const fingerprints = conversations
      .flatMap((c) => c.observations)
      .map((o) => computeFingerprint(fingerprintForObservation(o, { repo: REPO })!));
    expect(new Set(fingerprints).size).toBe(3);
  });

  it("survives a rescan: the same submission twice yields identical fingerprints", () => {
    const one = collectNetworkFlowObservations(REPO, [withCipher]);
    const two = collectNetworkFlowObservations(REPO, [withCipher]);
    const fp = (r: typeof one) =>
      r.conversations.flatMap((c) => c.observations).map((o) => computeFingerprint(fingerprintForObservation(o, { repo: REPO })!));
    expect(fp(one)).toEqual(fp(two));
  });
});

describe("collectNetworkFlowObservations — what it refuses to report", () => {
  it("does NOT infer cryptography from the port", () => {
    // Port 443 is not evidence of TLS 1.3. It is not evidence of TLS. It is
    // evidence that something listened on 443.
    for (const port of [443, 8443, 22, 993, 465]) {
      const { conversations } = collectNetworkFlowObservations(REPO, [
        record({ destination: { hostname: "svc.internal", port } }),
      ]);
      expect(conversations[0].cryptoState, String(port)).toBe("undetermined");
      expect(conversations[0].observations, String(port)).toEqual([]);
    }
  });

  it("does NOT infer a key exchange from a TLS 1.3 suite name", () => {
    // RFC 8446 mandates an (EC)DHE exchange for every TLS 1.3 handshake, and
    // B3's prober records one — because it completed the handshake. A log line
    // does not let us say that.
    const { conversations, reobservedLocations } = collectNetworkFlowObservations(REPO, [
      record({ tlsVersion: "TLSv1.3", cipherSuite: "TLS_AES_128_GCM_SHA256" }),
    ]);
    const [flow] = conversations;
    expect(flow.observations.map((o) => o.algorithm)).toEqual(["AES"]);
    expect(flow.observations.map((o) => o.algorithm)).not.toContain("ECDH/DH");
    expect(flow.gaps.map((g) => g.component)).toContain("key-exchange-not-named");
    expect(flow.gaps.map((g) => g.component)).toContain("authentication-not-named");
    // Only the slot it really did observe is reconcilable.
    expect(reobservedLocations).toEqual([networkFlowLocation(REPO, "tcp", "payments.internal", 443, "bulk-cipher")]);
  });

  it("does NOT let a cipher-free record retract a cipher another record stated", () => {
    // A VPC flow log and a load-balancer access log describe the same
    // conversation; only one of them carries a cipher. Silence is not a denial.
    const { conversations, reobservedLocations } = collectNetworkFlowObservations(REPO, [
      record({ recordFormat: "load-balancer-access-log", cipherSuite: "ECDHE-RSA-AES128-GCM-SHA256" }),
      record({ recordFormat: "vpc-flow-log" }),
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].cryptoState).toBe("observed");
    expect(conversations[0].reportedCipherSuite).toBe("ECDHE-RSA-AES128-GCM-SHA256");
    expect(reobservedLocations).toHaveLength(3);
  });

  it("reports an unresolvable suite as a gap and reconciles nothing", () => {
    const { conversations, reobservedLocations } = collectNetworkFlowObservations(REPO, [
      record({ cipherSuite: "TLS_RSA_WITH_NULL_SHA" }),
    ]);
    // NULL names no encryption at all — a real fact, but not an algorithm.
    expect(conversations[0].observations.map((o) => o.algorithm)).toEqual(["RSA", "RSA"]);
    expect(conversations[0].gaps.map((g) => g.component)).toContain("bulk-cipher-none");

    const chacha = collectNetworkFlowObservations(REPO, [record({ cipherSuite: "!!!" })]);
    expect(chacha.conversations[0].cryptoState).toBe("undetermined");
    expect(chacha.conversations[0].gaps[0].reason).toBe("cipher-suite-not-recognised");
    expect(chacha.reobservedLocations).toEqual([]);
    expect(reobservedLocations.length).toBeGreaterThan(0);
  });

  it("never records the TLS version as an observation — a version is not an algorithm", () => {
    const { conversations } = collectNetworkFlowObservations(REPO, [
      record({ tlsVersion: "TLSv1.0", cipherSuite: undefined }),
    ]);
    expect(conversations[0].observations).toEqual([]);
    expect(conversations[0].cryptoState).toBe("undetermined");
  });
});
