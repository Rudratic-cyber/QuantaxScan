import {
  canonicalCertificateKeyAlgorithm,
  decodeTlsPolicy,
  resolveHostIdentity,
  type DecodedTlsPolicy,
  type DeclarationStrength,
  type EndpointCertificateReport,
  type EndpointHostReport,
  type EndpointHostSkipReason,
} from "./endpoint-report";
import type { EndpointLocationDetail } from "./location-detail";
import type { CollectorCapabilities, RawObservation } from "./types";

/**
 * EP — the endpoint / host-fleet collector's observation layer
 * (docs/Claude/03-features.md EP: "Windows and Linux host fleet — machine
 * certificate stores, host TLS policy, loaded providers").
 *
 * Pure and dependency-free like every collector here: it maps an already
 * collected {@link EndpointHostReport} to observations and does no I/O. The
 * decoding — cipher-suite token tables, the disabled-algorithm suppression,
 * certificate key-algorithm canonicalisation, host identity — lives in
 * `endpoint-report.ts`; this file is where the evidence tiers are priced and
 * where the reobservation scope is decided.
 *
 * ## No agent ships in this change, deliberately
 *
 * The report format above is the contract a host agent reports *against*. The
 * agent itself is out of scope and that is a decision, not an omission: a
 * binary that runs on a customer's domain controller is a packaging and
 * security-review problem several times the size of a collector, and it cannot
 * authenticate to anything until credential handling (F4) lands. Shipping the
 * contract and the ingest first means the agent has a defined thing to send and
 * somewhere to send it, and it means the format is settled before anything is
 * deployed against it.
 *
 * ## Why `endpoint_monitoring`
 *
 * SP 1800-38B §4.1.4 names four modalities and this is the first collector in
 * the product to use `endpoint_monitoring` — the modality was defined for
 * exactly this: cryptography read from the host itself rather than off the wire
 * or out of an artefact. It is not `configuration_information`: B5/B6/B7 read a
 * document someone sent, while this reads a machine's own live state. It is
 * emphatically not `active_network_scan`, which is B3's and means an algorithm
 * negotiated on the wire.
 *
 * ## Confidence, on the scale that already exists
 *
 * B6 established the split and its vocabulary is reused rather than a second
 * one invented (`docs/Claude/09-open-gaps.md` G-11 has the whole ladder):
 *
 *  - **`permitted` → 0.6.** An enabled cipher suite. The registry read is
 *    exact; the claim it supports is only that the host would negotiate this if
 *    a peer asked, and most of a Schannel suite list is never selected. Same
 *    number as B6's `Ciphers` line because it is the same claim about a
 *    different kind of file.
 *  - **`materialised` → 0.8.** A certificate present in one of the host's
 *    machine stores. This key exists, on this machine, now.
 *
 * `materialised` stops at 0.8 rather than reaching B4's 0.9, and the gap is the
 * honest one: B4 parses the certificate's own bytes, while this reads a store's
 * *rendering* of them. If the store says `ECC` and `256`, that is the store's
 * word — good evidence, but one remove from the artefact. Neither tier
 * approaches B3's 1.0, which remains reserved for a completed handshake.
 *
 * ## What produces no observation at all, and why that is the design
 *
 *  - **Protocol versions.** `algorithms.json` catalogues algorithms; there is
 *    no `TLS 1.0` entry and adding one would put the algorithm vocabulary in
 *    two places. The posture is carried as host context instead.
 *  - **Loaded providers.** A provider is a capability, not a key. "Microsoft
 *    Platform Crypto Provider is loaded" would otherwise become a finding on
 *    every Windows machine in existence.
 *  - **The OS build.** Carried so a reader knows what the defaults *would* have
 *    been, and never used to decide what they are.
 *
 * ## There is no host table, and the consequence is real
 *
 * A host exists here only as the assets it produced. A host that reports a
 * fully hardened policy and an empty machine store is recorded as a collection
 * run — `examined, nothing found`, which is the honest D3 reading — but it is
 * not a row anything can list. Giving the surface an `endpoint_hosts` table is
 * the right eventual model and was left out of this change on purpose: it costs
 * a migration, an RLS policy and a grant, and none of that is needed to make
 * the surface real. It is recorded as a follow-up rather than pretended away.
 */

/** See the module header's ladder. Exported so a test can assert the ordering against the other collectors rather than trusting the prose. */
export const ENDPOINT_CONFIDENCE: Record<DeclarationStrength, number> = {
  permitted: 0.6,
  materialised: 0.8,
};

export const ENDPOINT_LOCATION_INFIX = "endpoint";

/** The certificate-store component key. The *store* is the slot, so a certificate removed from it is correctly retired. */
export function endpointCertificateStoreComponent(store: string): string {
  return `certificate-store:${store}`;
}

/** The cipher-suite component key. One slot per host: the whole suite list is read or it is not. */
export const ENDPOINT_CIPHER_SUITES_COMPONENT = "tls-cipher-suites";

/**
 * The asset `location` for one slot on one host.
 *
 * The **(machine, component)** pair is the stable slot, the same way a file
 * path is B6's. That is what makes the lifecycle work: an administrator pruning
 * a suite from the registry and the agent re-running leaves the slot in the
 * reobservation scope while that suite's fingerprint goes unreobserved, so the
 * asset is correctly marked `gone`. Folding the suite name into the location
 * would take every removal out of its own scope and leave retired suites active
 * forever.
 */
export function endpointLocation(repo: string, machineId: string, component: string): string {
  return `${repo}:${ENDPOINT_LOCATION_INFIX}:${machineId}:${component}`;
}

/** What one host in a submission produced — including the hosts that produced nothing, which the caller must be able to report. */
export interface EndpointHostResult {
  machineId: string;
  hostname: string | null;
  /** Set when the host was not ingested at all. `observations` and `reobservedLocations` are then empty. */
  skipped?: EndpointHostSkipReason;
  observations: RawObservation[];
  /**
   * The slots this host's report actually spoke about — see
   * {@link collectEndpointObservations}'s reobservation rule.
   */
  reobservedLocations: string[];
  certificatesRead: number;
  /** `null` when the host reported no TLS policy at all, which is different from reporting one that declares nothing. */
  tlsPolicy: DecodedTlsPolicy | null;
}

function hostContext(host: EndpointHostReport, tlsPolicy: DecodedTlsPolicy | null): Omit<EndpointLocationDetail, "component" | "observedToken" | "strength"> {
  return {
    machineId: host.machineId,
    machineIdSource: host.machineIdSource,
    hostname: host.hostname,
    os: host.os,
    collectedAt: host.collectedAt,
    providers: host.providers,
    tlsPolicy:
      tlsPolicy === null
        ? undefined
        : {
            provider: tlsPolicy.provider,
            enabledProtocols: tlsPolicy.enabledProtocols,
            disabledProtocols: tlsPolicy.disabledProtocols,
            undeterminedProtocols: tlsPolicy.undeterminedProtocols,
          },
  };
}

function certificateObservation(
  repo: string,
  host: EndpointHostReport,
  context: ReturnType<typeof hostContext>,
  store: string,
  certificate: EndpointCertificateReport,
): RawObservation | undefined {
  if (certificate.publicKeyAlgorithm === undefined) return undefined;
  const resolved = canonicalCertificateKeyAlgorithm(certificate.publicKeyAlgorithm);
  // A key algorithm this collector does not recognise produces nothing — not a
  // guess, and not an "unknown" asset. That covers every post-quantum
  // certificate: silently absent beats confidently classical.
  if (!resolved) return undefined;

  const component = endpointCertificateStoreComponent(store);
  const detail: EndpointLocationDetail = {
    ...context,
    component,
    observedToken: certificate.thumbprint,
    strength: "materialised",
    certificate: {
      store,
      thumbprint: certificate.thumbprint,
      reportedAlgorithm: certificate.publicKeyAlgorithm,
      subject: certificate.subject,
      issuer: certificate.issuer,
      serialNumber: certificate.serialNumber,
      notBefore: certificate.notBefore,
      notAfter: certificate.notAfter,
      hasPrivateKey: certificate.hasPrivateKey,
    },
  };

  return {
    algorithm: resolved.algorithm,
    // The store's stated size wins; the table's fixed size is the fallback and
    // exists only for algorithms whose identifier fixes it (Ed25519 is 256 bits
    // by definition). Neither is a per-family default — an `ECC` key with no
    // stated size stays undetermined (G-05).
    keySize: certificate.keySize ?? resolved.keySize,
    location: endpointLocation(repo, host.machineId, component),
    locationDetail: { kind: "endpoint", endpoint: detail },
    discoveryModality: "endpoint_monitoring",
    confidence: ENDPOINT_CONFIDENCE.materialised,
    evidence: {
      machineId: host.machineId,
      hostname: host.hostname ?? null,
      store,
      thumbprint: certificate.thumbprint,
      reportedAlgorithm: certificate.publicKeyAlgorithm,
      subject: certificate.subject ?? null,
      notAfter: certificate.notAfter ?? null,
      hasPrivateKey: certificate.hasPrivateKey ?? null,
      strength: "materialised",
      note:
        "A certificate present in this host's machine store, as the store renders it. Not a parsed artefact — " +
        "POST /projects/:id/certificates reads the bytes themselves and carries higher confidence for that reason.",
    },
  };
}

function cipherSuiteObservation(
  repo: string,
  host: EndpointHostReport,
  context: ReturnType<typeof hostContext>,
  suite: string,
  component: { token: string; algorithm: string; keySize?: number },
): RawObservation {
  const detail: EndpointLocationDetail = {
    ...context,
    component: ENDPOINT_CIPHER_SUITES_COMPONENT,
    observedToken: suite,
    strength: "permitted",
  };

  return {
    algorithm: component.algorithm,
    keySize: component.keySize,
    location: endpointLocation(repo, host.machineId, ENDPOINT_CIPHER_SUITES_COMPONENT),
    locationDetail: { kind: "endpoint", endpoint: detail },
    discoveryModality: "endpoint_monitoring",
    confidence: ENDPOINT_CONFIDENCE.permitted,
    evidence: {
      machineId: host.machineId,
      hostname: host.hostname ?? null,
      cipherSuite: suite,
      suiteToken: component.token,
      strength: "permitted",
      note:
        "This host's policy enables this cipher suite. Not evidence any peer negotiated it — a suite list is an " +
        "upper bound on what would be accepted. Suites the host's disabled-algorithm policy makes unnegotiable are " +
        "not reported at all.",
    },
  };
}

/**
 * Map one host's report to observations.
 *
 * **The reobservation scope is the crux of this function, so it is built here
 * rather than by the caller.** A slot enters the scope when the host's report
 * *spoke about it* — not when it produced an observation, and not merely
 * because the host was in the submission:
 *
 *  - `certificateStores` absent → the agent did not read the stores, so every
 *    previously recorded certificate on this host is left alone. An agent that
 *    can only read the TLS policy must not silently retire a machine's keys.
 *  - a store present but empty → it *was* read and holds nothing, so its
 *    certificates are correctly marked `gone`.
 *  - `tlsPolicy.cipherSuites` absent → same rule one level down. A report
 *    carrying only `protocols` and `providers` says nothing about the suite
 *    list and leaves it untouched.
 *  - a suite list present but every entry `enabled: false`, or every suite
 *    suppressed → the slot is in scope and its assets retire. That is the
 *    hardening event this surface exists to show.
 *
 * The last case is why the scope cannot be derived from the observations: a
 * host that removed its last weak suite produces zero observations for that
 * slot, and a scope built from what was *found* would never contain it, so the
 * removed suite would stay `active` forever — the A1 acceptance criterion
 * broken for exactly the change the feature is meant to detect.
 */
export function observationsFromEndpointHost(repo: string, host: EndpointHostReport): EndpointHostResult {
  const tlsPolicy = host.tlsPolicy === undefined ? null : decodeTlsPolicy(host.tlsPolicy);
  const context = hostContext(host, tlsPolicy);

  const observations: RawObservation[] = [];
  const reobservedLocations: string[] = [];
  let certificatesRead = 0;

  for (const store of host.certificateStores ?? []) {
    reobservedLocations.push(endpointLocation(repo, host.machineId, endpointCertificateStoreComponent(store.store)));
    for (const certificate of store.certificates) {
      certificatesRead += 1;
      const observation = certificateObservation(repo, host, context, store.store, certificate);
      if (observation) observations.push(observation);
    }
  }

  if (host.tlsPolicy?.cipherSuites !== undefined && tlsPolicy !== null) {
    reobservedLocations.push(endpointLocation(repo, host.machineId, ENDPOINT_CIPHER_SUITES_COMPONENT));
    for (const declaration of tlsPolicy.declarations) {
      observations.push(cipherSuiteObservation(repo, host, context, declaration.suite, declaration.component));
    }
  }

  return {
    machineId: host.machineId,
    hostname: host.hostname ?? null,
    observations,
    reobservedLocations,
    certificatesRead,
    tlsPolicy,
  };
}

/**
 * Every host in a submission, in order, with the skipped ones kept in place.
 *
 * Skipped hosts are returned rather than filtered out because the caller has to
 * be able to say *which* host it refused and why: a host that vanishes from the
 * result is indistinguishable from one with nothing to report, and only one of
 * those is a bug in the agent. See `resolveHostIdentity` for the three reasons.
 */
export function collectEndpointObservations(repo: string, hosts: readonly EndpointHostReport[]): EndpointHostResult[] {
  return resolveHostIdentity(hosts).map(({ host, skipped }) => {
    if (skipped !== undefined) {
      return {
        machineId: host.machineId,
        hostname: host.hostname ?? null,
        skipped,
        observations: [],
        reobservedLocations: [],
        certificatesRead: 0,
        tlsPolicy: null,
      };
    }
    return observationsFromEndpointHost(repo, host);
  });
}

/**
 * The collector's declared capabilities.
 *
 * There is no `Collector` *class* here, which follows B5, B7 and B8 rather than
 * B1/B2/B4/B6: the `Collector` interface is built around `CollectionTarget`,
 * the source/file shape, and a host report is not a set of files. A class whose
 * `collect()` yielded nothing would satisfy the interface and mislead every
 * reader of it. The real entry point is
 * {@link collectEndpointObservations}.
 */
export const ENDPOINT_COLLECTOR_CAPABILITIES: CollectorCapabilities = {
  // The nominal tier: most observations on this surface are enabled cipher
  // suites. A machine-store certificate carries 0.8 — see ENDPOINT_CONFIDENCE.
  confidence: ENDPOINT_CONFIDENCE.permitted,
  // Only where the evidence states one: a suite name's AES width, or a size the
  // certificate store itself reported. Never derived from an algorithm name —
  // an `ECC` certificate with no stated size stays undetermined (G-05).
  canDetermineKeySize: true,
};
