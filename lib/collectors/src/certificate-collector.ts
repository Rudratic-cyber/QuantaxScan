import { X509Certificate } from "node:crypto";
import { curveBitSize } from "./named-curves";
import type { Collector, CollectorContext, CollectionTarget, RawObservation } from "./types";
import type { CertificateLocationDetail } from "./location-detail";

/**
 * B4 — the certificate / X.509 collector (docs/Claude/03-features.md B4;
 * docs/Claude/02-roadmap.md M2: "Certificate inventory shows which certs
 * outlive the conservative Q-Day scenario").
 *
 * Reads *submitted* PEM/DER certificate material — the same shape of input
 * as B2's lockfile collector (a file the caller already has), not a live TLS
 * fetch. Fetching certificates from a live host is a different surface
 * (`network` locationDetail, the same profile `tls` will use) and is
 * explicitly out of scope for this collector; see the discriminator comment
 * in `enums.ts`.
 *
 * `node:crypto`'s `X509Certificate` does all the parsing — no third-party
 * dependency, keeping `@workspace/collectors` able to ship as a standalone
 * on-prem agent (AGENTS.md §"Package boundaries"). `fingerprint.ts` already
 * imports `node:crypto` for the same reason.
 */

/**
 * Canonical algorithm name (must resolve in `algorithms.json`) for each
 * `asymmetricKeyType` Node's `X509Certificate.publicKey` can report.
 *
 * `ec` is mapped to `ECDSA` unconditionally. A certificate's EC public key
 * *could* be ECDH-only (key-agreement, not signing) rather than ECDSA, and
 * the X.509 `keyUsage` extension is the only way to tell — but it is
 * frequently absent (confirmed empirically against a self-signed test
 * certificate with no extensions: `x.keyUsage` is `undefined`), so keying
 * the algorithm name off its presence would silently misclassify exactly the
 * certificates that omit it. The overwhelming majority of EC certificates in
 * practice are ECDSA (TLS server auth), and both entries are quantum-
 * vulnerable via the same primitive (ECDLP/Shor) either way, so this is a
 * documented simplification rather than a guess with consequences: it can
 * mislabel an ECDH-only certificate's *replacement standard* (ML-DSA vs
 * ML-KEM), never its quantum-vulnerability verdict.
 */
const ALGORITHM_BY_KEY_TYPE: Record<string, string> = {
  rsa: "RSA",
  "rsa-pss": "RSA",
  dsa: "DSA",
  ec: "ECDSA",
  ed25519: "EdDSA",
  ed448: "EdDSA",
  x25519: "ECDH/DH",
  x448: "ECDH/DH",
};

/** The canonical algorithm names this collector can emit. Every one must resolve in `algorithms.json` — asserted in algorithm-mapping.test.ts. */
export const CERTIFICATE_KEY_ALGORITHMS: readonly string[] = [...new Set(Object.values(ALGORITHM_BY_KEY_TYPE))];

/**
 * Confidence (docs/Claude/09-open-gaps.md G-11). A parsed X.509 certificate
 * states its own public-key algorithm and size directly: there is no
 * ambiguity comparable to the dependency collector's "which of several
 * primitives does the caller actually invoke?" (its 0.5 tier), or even its
 * 0.8 "dedicated package" tier — a certificate has exactly one public key,
 * and this collector reads it rather than infers it. It sits below a
 * completed TLS handshake's 1.0 because parsing a submitted file proves the
 * certificate exists and states what it states, not that it is currently
 * presented by a live endpoint or trusted by any relying party.
 */
const CERTIFICATE_CONFIDENCE = 0.9;

const PEM_CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Split a submitted PEM file into its individual certificate blocks.
 *
 * This is load-bearing, not a style choice: Node's `X509Certificate`
 * constructor silently parses only the *first* certificate when handed a
 * multi-certificate PEM string (a chain bundle — leaf + intermediates) —
 * confirmed empirically, with no error, warning, or property indicating
 * anything was dropped. A caller submitting a chain would otherwise have the
 * intermediates silently vanish. Splitting on the `-----BEGIN/END
 * CERTIFICATE-----` markers first, then constructing one `X509Certificate`
 * per block, is what actually reads every certificate in a bundle.
 */
function splitPemCertificates(content: string): string[] {
  return content.match(PEM_CERT_BLOCK) ?? [];
}

/**
 * Parse one submitted file into zero or more certificates. PEM is detected
 * by its marker; anything else is treated as base64-encoded DER, the only
 * way a binary certificate can travel inside a JSON string body. A file that
 * is neither contributes zero certificates rather than an error — the same
 * tolerant-parser discipline `lockfiles.ts` uses: an unparsed file produces
 * *fewer* observations, never a wrong one.
 */
function parseCertificates(content: string): X509Certificate[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.includes("-----BEGIN CERTIFICATE-----")) {
    const out: X509Certificate[] = [];
    for (const block of splitPemCertificates(trimmed)) {
      try {
        out.push(new X509Certificate(block));
      } catch {
        // Not a well-formed certificate block — skip rather than guess.
      }
    }
    return out;
  }

  // Not PEM. Try base64-encoded DER. `Buffer.from(..., "base64")` does not
  // throw on malformed input (Node decodes leniently), so a non-certificate
  // string still reaches `X509Certificate`, which is what actually rejects it.
  try {
    const der = Buffer.from(trimmed, "base64");
    if (der.length === 0) return [];
    return [new X509Certificate(der)];
  } catch {
    return [];
  }
}

function keySizeOf(cert: X509Certificate): number | undefined {
  const key = cert.publicKey;
  const details = key.asymmetricKeyDetails;
  switch (key.asymmetricKeyType) {
    case "rsa":
    case "rsa-pss":
    case "dsa":
      // The stated modulus size — not a derived security-strength category (G-05).
      return details?.modulusLength;
    case "ec":
      return details?.namedCurve ? curveBitSize(details.namedCurve) : undefined;
    case "ed25519":
    case "ed448":
    case "x25519":
    case "x448":
      // These curves are named by `asymmetricKeyType` itself; `named-curves.ts`
      // already knows their bit sizes (see its table).
      return curveBitSize(key.asymmetricKeyType);
    default:
      return undefined;
  }
}

/** RDN sequence as Node renders it (newline-joined components) — flattened for a readable single-line `location`/`evidence` value. Not parsed into fields: nothing here queries an individual RDN attribute. */
function flattenName(name: string): string {
  return name.replace(/\n/g, ", ");
}

/**
 * Synchronous detection, mirroring `collectDependencyObservations` and
 * `collectSourceObservations`: parsing in-memory certificate material has no
 * genuine asynchrony.
 */
export function collectCertificateObservations(target: CollectionTarget): RawObservation[] {
  const observations: RawObservation[] = [];

  for (const file of target.files) {
    for (const cert of parseCertificates(file.content)) {
      const keyType = cert.publicKey.asymmetricKeyType;
      const algorithm = keyType ? ALGORITHM_BY_KEY_TYPE[keyType] : undefined;
      // An unrecognised or absent key type contributes no observation rather
      // than a guessed algorithm name — the same discipline as a dependency
      // package absent from crypto-packages.json.
      if (!algorithm) continue;

      const issuer = flattenName(cert.issuer);
      const subject = flattenName(cert.subject);
      const serialNumber = cert.serialNumber;
      const notBefore = cert.validFromDate.toISOString();
      const notAfter = cert.validToDate.toISOString();

      const certificateDetail: CertificateLocationDetail = {
        issuer,
        serialNumber,
        notBefore,
        notAfter,
        subject,
        signatureAlgorithm: cert.signatureAlgorithm,
        fingerprintSha256: cert.fingerprint256,
      };

      observations.push({
        algorithm,
        keySize: keySizeOf(cert),
        /**
         * `<repo>:cert:<issuer>:<serial>` — the certificate's own identity
         * (issuer + serial, the same pair `fingerprint.ts` uses), not a
         * content hash and not the submitted file path. A certificate is not
         * a stable "slot" the way a source file path or a dependency's
         * ecosystem prefix is: renewing a certificate mints a new serial, so
         * the renewed certificate is a genuinely different asset, not an
         * update to the old one. See `asset-ingest.ts`'s
         * `ingestCertificateObservations` for what this means for the
         * reobservation/lifecycle scope.
         */
        location: `${target.repo}:cert:${issuer}:${serialNumber}`,
        locationDetail: { kind: "certificate", certificate: certificateDetail },
        discoveryModality: "static_artifact_analysis",
        confidence: CERTIFICATE_CONFIDENCE,
        evidence: {
          filePath: file.path,
          issuer,
          subject,
          serialNumber,
          notBefore,
          notAfter,
          signatureAlgorithm: cert.signatureAlgorithm,
          publicKeyType: keyType,
          fingerprintSha256: cert.fingerprint256,
        },
      });
    }
  }

  return observations;
}

/** Whether a target contains anything this collector can read at all, and how many certificates each file carried — useful for coverage reporting (D3) and the ingest route's "did we examine anything" check. */
export function certificatesIn(target: CollectionTarget): Array<{ path: string; certificateCount: number }> {
  return target.files
    .map((file) => ({ path: file.path, certificateCount: parseCertificates(file.content).length }))
    .filter((entry) => entry.certificateCount > 0);
}

export class CertificateCollector implements Collector {
  readonly name = "certificate-x509";
  readonly version = "1.0.0";
  readonly surface = "certificate" as const;
  readonly capabilities = { confidence: CERTIFICATE_CONFIDENCE, canDetermineKeySize: true };

  async *collect(target: CollectionTarget, _ctx: CollectorContext): AsyncIterable<RawObservation> {
    for (const observation of collectCertificateObservations(target)) {
      yield observation;
    }
  }
}
