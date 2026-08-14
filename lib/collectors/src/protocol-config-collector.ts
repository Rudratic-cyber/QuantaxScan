import {
  detectProtocolConfigFormat,
  parseProtocolConfig,
  type DeclarationStrength,
  type DeclaredAlgorithm,
  type ProtocolConfigFormat,
} from "./protocol-config";
import type { ConfigLocationDetail } from "./location-detail";
import type { Collector, CollectionTarget, CollectorContext, RawObservation } from "./types";

/**
 * B6 — the protocol-configuration collector (docs/Claude/03-features.md B6:
 * "SSH, IPsec, JWT `alg`, SAML/OIDC signing").
 *
 * Pure and dependency-free, like every other collector in this package: it is
 * handed file contents (the submission shape `POST /projects/:id/dependencies`
 * and `POST /projects/:id/certificates` already established — path + content)
 * and returns observations. No socket, no filesystem, no network. The parsing
 * itself lives in `protocol-config.ts`; this file is the observation layer and
 * the place the evidence tiers are priced.
 *
 * ## Why these observations are `configuration_information`, not a scan
 *
 * SP 1800-38B §4.1.4's `configuration_information` modality is "declared or
 * queried configuration", and that is exactly what this reads. It is the same
 * modality B5 (KMS) and B7 (data-at-rest) use, and deliberately **not**
 * `active_network_scan` — that is B3's, and it means something stronger: an
 * algorithm actually negotiated on the wire.
 *
 * ## Confidence, anchored against the tiers that already exist
 *
 * The scale in play across this package (docs/Claude/09-open-gaps.md G-11):
 *
 * | 0.5 | dependency, multi-primitive library — present in the graph, may not be called |
 * | 0.7 | source regex — the code names the primitive |
 * | 0.8 | dependency, dedicated library — the package exists to do this |
 * | 0.9 | parsed X.509 certificate — the artefact states its own key |
 * | 1.0 | completed TLS handshake — observed on the wire |
 *
 * A configuration declaration splits into two tiers, because two genuinely
 * different claims hide under "the config says so":
 *
 *  - **`permitted` → 0.6.** `Ciphers`, `KexAlgorithms`, an IPsec proposal, an
 *    OIDC `*_alg_values_supported` list. The *parse* is exact — there is no
 *    ambiguity about what the file says — but the claim it supports is only
 *    that the endpoint would accept this algorithm if a peer asked. It may
 *    never be selected. That is stronger evidence than "a general-purpose
 *    crypto library is somewhere in the dependency graph" (0.5) and weaker
 *    than "this line of code names the primitive" (0.7), which is where it
 *    sits.
 *  - **`materialised` → 0.8.** An `authorized_keys` entry, a published JWK, the
 *    method a SAML document was actually signed with. These name a *specific
 *    key or a specific chosen algorithm*, not a menu — the algorithm exists,
 *    on this host, now. That matches the dedicated-library tier and stays
 *    below a parsed certificate (0.9), because a certificate is the artefact
 *    itself while this is still a file describing one.
 *
 * Neither tier may approach 1.0, and the reason is worth stating plainly: if a
 * config file's claim carried the same weight as an observed handshake, the
 * product's strongest evidence would be indistinguishable from its weakest,
 * and a hardening change that nobody deployed would read as a fixed estate.
 */

/** See the module header's table. Exported so a test can assert the ordering against the other collectors rather than trusting the prose. */
export const PROTOCOL_CONFIG_CONFIDENCE: Record<DeclarationStrength, number> = {
  permitted: 0.6,
  materialised: 0.8,
};

/**
 * A recognised configuration file, and how much it declared.
 *
 * `declarationCount: 0` is a real and important state: the file *is* an
 * `sshd_config`, it was read, and it names no crypto (every directive left at
 * the compiled-in default). That is "examined, found nothing" — a collection
 * run must be recorded for it. A file absent from this list entirely was not
 * understood at all, and recording a run for that would tell the D3 meter the
 * config surface had been examined when nothing readable was submitted.
 */
export interface RecognisedProtocolConfig {
  path: string;
  format: ProtocolConfigFormat;
  declarationCount: number;
}

/** Which submitted files are protocol configurations this collector understands. The ingest path's "did we examine anything" gate. */
export function protocolConfigsIn(target: CollectionTarget): RecognisedProtocolConfig[] {
  return target.files.flatMap((file) => {
    const format = detectProtocolConfigFormat(file.path, file.content);
    if (!format) return [];
    return [{ path: file.path, format, declarationCount: parseProtocolConfig(format, file.content).length }];
  });
}

/**
 * The asset `location` for a configuration file.
 *
 * The **file** is the stable slot, exactly as it is for the source collector
 * (`<repo>:<path>`), and unlike the certificate collector where the location
 * carries the certificate's own identity. The consequence is the one that
 * matters for lifecycle: removing `ssh-rsa` from a `HostKeyAlgorithms` line
 * and resubmitting the file leaves the file's location in the reobservation
 * scope while that fingerprint goes unreobserved, so the asset is correctly
 * marked `gone` — which is the whole A1 acceptance criterion. A location that
 * encoded the directive or the algorithm would take the removed declaration
 * out of scope along with itself, and the stale asset would live forever.
 *
 * The `config:` infix keeps it out of the way of a source asset for the same
 * path, which is possible in principle (nothing stops a caller submitting the
 * same file to both routes) and would otherwise collide two surfaces on one
 * locator.
 */
export function protocolConfigLocation(repo: string, path: string): string {
  return `${repo}:config:${path}`;
}

function toObservation(repo: string, file: { path: string }, format: ProtocolConfigFormat, declaration: DeclaredAlgorithm): RawObservation {
  const configDetail: ConfigLocationDetail = {
    path: file.path,
    format,
    directive: declaration.directive,
    declaredValue: declaration.token,
    strength: declaration.strength,
    condition: declaration.condition,
  };

  return {
    algorithm: declaration.algorithm,
    keySize: declaration.keySize,
    location: protocolConfigLocation(repo, file.path),
    locationDetail: { kind: "config", config: configDetail },
    discoveryModality: "configuration_information",
    confidence: PROTOCOL_CONFIG_CONFIDENCE[declaration.strength],
    evidence: {
      path: file.path,
      format,
      directive: declaration.directive,
      declaredValue: declaration.token,
      strength: declaration.strength,
      condition: declaration.condition ?? null,
      // Stated on the observation, not only in a code comment, so a reader of
      // `observations.evidence` sees the boundary too — the same move
      // `tls-collector.ts` makes for what it is *not* recording.
      note:
        declaration.strength === "permitted"
          ? "Declared as permitted by this configuration. Not evidence any peer negotiated it — see B3 for what was actually agreed on the wire."
          : "A specific key or chosen algorithm named by this configuration. Not evidence of a completed handshake — see B3.",
    },
  };
}

/**
 * Synchronous detection, mirroring `collectDependencyObservations` and
 * `collectCertificateObservations`: parsing in-memory text has no genuine
 * asynchrony.
 */
export function collectProtocolConfigObservations(target: CollectionTarget): RawObservation[] {
  const observations: RawObservation[] = [];

  for (const file of target.files) {
    const format = detectProtocolConfigFormat(file.path, file.content);
    if (!format) continue;
    for (const declaration of parseProtocolConfig(format, file.content)) {
      observations.push(toObservation(target.repo, file, format, declaration));
    }
  }

  return observations;
}

export class ProtocolConfigCollector implements Collector {
  readonly name = "protocol-config";
  readonly version = "1.0.0";
  readonly surface = "config" as const;
  readonly capabilities = {
    // The nominal tier. A `materialised` declaration carries 0.8 — see
    // PROTOCOL_CONFIG_CONFIDENCE; `capabilities.confidence` is one number by
    // contract, so it reports the tier most observations land in.
    confidence: PROTOCOL_CONFIG_CONFIDENCE.permitted,
    // Only where the token itself names one (a curve, a MODP group, an AES
    // width, a JWK modulus). An `ssh-rsa` authorized_keys entry stays
    // undetermined rather than guessed — G-05.
    canDetermineKeySize: true,
  };

  async *collect(target: CollectionTarget, _ctx: CollectorContext): AsyncIterable<RawObservation> {
    for (const observation of collectProtocolConfigObservations(target)) {
      yield observation;
    }
  }
}
