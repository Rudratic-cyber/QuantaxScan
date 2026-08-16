import { curveBitSize } from "./named-curves";
import type { RawObservation } from "./types";

/**
 * B3 — the TLS/cipher-suite prober's pure half (docs/Claude/03-features.md
 * §B3: "Active handshake against hosts. Records *negotiated* KEX, not
 * configured"). docs/Claude/marketing/01-positioning.md's "the market is
 * agentless-first" is why this surface matters commercially: it needs no
 * repository access, unlike source (B1) and dependency (B2), which is the
 * argument the doc makes for building B3 next.
 *
 * This module does **no socket I/O** — it is dependency-free like the rest of
 * `lib/collectors`, so the package can still ship as a standalone on-prem
 * agent. The actual `node:tls` connection, and the SSRF guard that decides
 * what this server is allowed to connect to, live in
 * `artifacts/api-server/src/lib/tls-probe.ts` and `tls-ssrf-guard.ts`. This
 * file only turns an already-completed handshake's result into
 * `RawObservation`s — the same split B1/B2 already have between "what did we
 * see" (pure) and "how did we see it" (I/O in the API server / a route).
 *
 * ## Two observations per target, not one
 *
 * A completed handshake is genuinely two separate crypto facts, and both are
 * quantum-relevant:
 *
 *  1. The **negotiated key-exchange algorithm and group** — the thing an
 *     attacker with a cryptographically relevant quantum computer breaks via
 *     Shor's algorithm to read traffic retroactively (harvest-now-decrypt-
 *     later). Canonical name `ECDH` or `DH` per the negotiated type (G-24) —
 *     `docs/Claude/mappings/algorithms.json`
 *     already lists `X25519`, `ECDHE`, `DHE` and `curve25519` as aliases of
 *     that one entry, so an X25519 handshake and a classic DHE handshake are
 *     correctly the same algorithm family for reporting purposes.
 *  2. The **peer leaf certificate's public key algorithm and size** — RSA,
 *     ECDSA or EdDSA, whichever key type the server authenticated with. This
 *     is *only* the key type, not the certificate — no issuer, no serial, no
 *     expiry, no chain. Full X.509 parsing is B4's surface
 *     (docs/Claude/03-features.md), deliberately not built here.
 *
 * Both are recorded as `surface: "tls"` (fingerprint `repo + host + port +
 * algorithm`), at the same `location`, because there is no issuer/serial to
 * fingerprint a certificate identity by — see `fingerprint.ts`'s comment on
 * why `certificate` (a genuinely different surface, `issuer + serial`) is out
 * of scope here. Two algorithms observed at one `host:port` is exactly the
 * dependency collector's `entry.algorithms` loop: same `location`, different
 * fingerprints, both real.
 *
 * A cipher suite name that offers no forward secrecy at all (an obsolete
 * static-RSA key-exchange cipher — no modern client/server negotiates this by
 * default, but it is not disallowed at the TLS protocol level) has no
 * `keyExchange` in the handshake result: the certificate's own RSA key *is*
 * the key-exchange mechanism there, so this collector emits only the
 * certificate observation for that case rather than a redundant second one at
 * the same algorithm. See {@link TlsHandshakeResult.keyExchange}'s own doc
 * for the distinct TLS 1.3 case, where a key exchange is known to have
 * happened but Node cannot report which group.
 */

/** What `tls-probe.ts` reports after a completed handshake — no `node:tls` types leak into this pure module's public surface. */
export interface TlsHandshakeResult {
  host: string;
  port: number;
  /** e.g. `"TLSv1.3"`, `"TLSv1.2"` — `tlsSocket.getProtocol()` verbatim. */
  protocolVersion: string;
  /** Negotiated cipher suite, e.g. `"TLS_AES_256_GCM_SHA384"` (TLS 1.3) or `"ECDHE-RSA-AES256-GCM-SHA384"` (TLS 1.2). */
  cipherSuiteName: string;
  /**
   * Whether *some* ephemeral key exchange occurred, and its detail when
   * known. This object being present (even with every field empty) means
   * "an ephemeral exchange happened"; its absence means the cipher used
   * static key transport (the certificate's own key doubled as the exchange
   * mechanism — see `tls-probe.ts` for when that is and is not inferred).
   *
   * **`name`/`bits` are frequently absent even when `type` is not, and that
   * is a real Node.js limitation, not a bug here.** `tlsSocket.
   * getEphemeralKeyInfo()` reports a populated `{ type, name, size }` for
   * TLS ≤ 1.2, but returns `{}` for TLS 1.3 — verified empirically against
   * Node v24.14.0 (`tls-probe.ts` has the reproduction). TLS 1.3 mandates an
   * ephemeral (EC)DHE exchange for every cipher suite (RFC 8446), so
   * `tls-probe.ts` still sets `type` for a TLS 1.3 handshake, but `name` and
   * `bits` stay undefined — the group really was undetermined by this
   * collector, not omitted by an oversight. `keySize` on the resulting
   * observation reflects that honestly (G-05: never a guessed default).
   */
  keyExchange?: {
    type?: "ECDH" | "DH";
    /** Curve/group name for ECDH (e.g. `"X25519"`, `"prime256v1"`); absent for plain (non-elliptic) DH, or when undetermined (see above). */
    name?: string;
    /** Bits, straight from Node — used only as a fallback when `name` names no curve this collector's table knows. */
    bits?: number;
  };
  /**
   * The leaf certificate's public key, from `getPeerX509Certificate()`'s
   * `.publicKey` (a `KeyObject`) — absent when the peer presented no usable
   * certificate (should not happen for a completed TLS handshake, but the
   * caller cannot rule it out, so this stays optional rather than asserted).
   */
  peerCertificatePublicKey?: {
    /** `KeyObject.asymmetricKeyType` verbatim — `"rsa" | "rsa-pss" | "ec" | "ed25519" | "ed448" | "dsa" | ...`. */
    keyType: string;
    /** RSA/DSA modulus length in bits (`asymmetricKeyDetails.modulusLength`). */
    modulusBits?: number;
    /** EC named curve (`asymmetricKeyDetails.namedCurve`), e.g. `"prime256v1"`. */
    namedCurve?: string;
  };
}

/**
 * Confidence for every observation this collector produces.
 *
 * Not a judgement call this file invents: `types.ts`'s `RawObservation.
 * confidence` doc comment already states the scale's two anchors — "Regex ≈
 * 0.7, a completed TLS handshake ≈ 1.0" — and docs/Claude/04-architecture.md
 * line 266 repeats it verbatim. A completed handshake is the strongest
 * evidence this whole product can produce: it is not an inference about what
 * a config file *permits* or what a library *offers* (the dependency
 * collector's 0.5–0.8 tiers, docs/Claude/09-open-gaps.md G-11) — it is a
 * direct observation of the algorithm actually negotiated on the wire. There
 * is no weaker-evidence tier to place TLS at; 1.0 is the honest number for
 * "we did the thing and this is what happened," not an inflated default.
 */
export const TLS_HANDSHAKE_CONFIDENCE = 1.0;

function canonicalCertKeyAlgorithm(keyType: string): string {
  switch (keyType.toLowerCase()) {
    case "rsa":
    case "rsa-pss":
      return "RSA";
    case "ec":
      return "ECDSA";
    case "ed25519":
    case "ed448":
      return "EdDSA";
    case "dsa":
      return "DSA";
    default:
      // An unrecognised KeyObject.asymmetricKeyType (x25519/x448 certs are
      // real but vanishingly rare, used for key-agreement-only certs) —
      // report it verbatim rather than mis-naming it as one of the four
      // above. The mapping engine's job (out of scope here, see C1) is to
      // handle an algorithm name it does not recognise, not this collector's.
      return keyType.toUpperCase();
  }
}

/** Bit size of the peer certificate's public key, or `undefined` when this collector cannot determine it — never a guessed default (G-05). */
function certKeyBitSize(pubkey: NonNullable<TlsHandshakeResult["peerCertificatePublicKey"]>): number | undefined {
  if (pubkey.namedCurve) return curveBitSize(pubkey.namedCurve) ?? pubkey.modulusBits;
  if (pubkey.keyType.toLowerCase() === "ed25519" || pubkey.keyType.toLowerCase() === "ed448") {
    return curveBitSize(pubkey.keyType);
  }
  return pubkey.modulusBits;
}

/** Bit size of the negotiated key-exchange group, or `undefined` when neither the named-curve table nor Node's own report has one. */
/**
 * Which of the two Diffie-Hellman families this handshake actually used.
 *
 * This is the sharpest instance of G-24 in the product, because it is the one
 * place a real endpoint hands us a real size. Node reports `type: "DH"` with
 * `bits: 2048` for a classic DHE handshake; until 2026-08-16 that was recorded
 * as `ECDH/DH` and 2048 was read against curve thresholds, landing it in the
 * `>= 128 bits` band. A live server negotiating DHE-2048 was told its first
 * milestone was 2035, when IR 8547 Table 4 deprecates 112-bit key
 * establishment after **2030**.
 *
 * `ECDH` is the default for an unrecognised type rather than `DH`, and that is
 * the conservative direction here rather than the generous one: every modern
 * TLS 1.3 group is elliptic or a hybrid, `bits` is absent for named curves so
 * `curveBitSize(name)` supplies the size, and mislabelling a P-256 exchange as
 * a 256-bit *modulus* would put it in the 112-bit band and invent a 2030
 * deadline that does not apply.
 */
function keyExchangeAlgorithm(kex: NonNullable<TlsHandshakeResult["keyExchange"]>): string {
  return kex.type?.toUpperCase() === "DH" ? "DH" : "ECDH";
}

function keyExchangeBitSize(kex: NonNullable<TlsHandshakeResult["keyExchange"]>): number | undefined {
  if (kex.name) return curveBitSize(kex.name) ?? kex.bits;
  return kex.bits;
}

export function observationsFromTlsHandshake(repo: string, result: TlsHandshakeResult): RawObservation[] {
  const location = `${repo}:${result.host}:${result.port}`;
  const locationDetail = {
    kind: "network" as const,
    network: {
      hostname: result.host,
      destinationPort: result.port,
    },
  };
  const sharedEvidence = {
    host: result.host,
    port: result.port,
    protocolVersion: result.protocolVersion,
    cipherSuite: result.cipherSuiteName,
  };

  const observations: RawObservation[] = [];

  if (result.keyExchange) {
    observations.push({
      algorithm: keyExchangeAlgorithm(result.keyExchange),
      keySize: keyExchangeBitSize(result.keyExchange),
      location,
      locationDetail,
      discoveryModality: "active_network_scan",
      confidence: TLS_HANDSHAKE_CONFIDENCE,
      evidence: {
        ...sharedEvidence,
        keyExchangeType: result.keyExchange.type ?? null,
        keyExchangeGroup: result.keyExchange.name ?? null,
      },
    });
  }

  if (result.peerCertificatePublicKey) {
    observations.push({
      algorithm: canonicalCertKeyAlgorithm(result.peerCertificatePublicKey.keyType),
      keySize: certKeyBitSize(result.peerCertificatePublicKey),
      location,
      locationDetail,
      discoveryModality: "active_network_scan",
      confidence: TLS_HANDSHAKE_CONFIDENCE,
      evidence: {
        ...sharedEvidence,
        peerCertificateKeyType: result.peerCertificatePublicKey.keyType,
        // Explicitly what this is NOT: subject, issuer, serial, validity —
        // B4's territory. Stated on the observation, not just in a code
        // comment, so a reader of `observations.evidence` sees the boundary
        // too.
        note: "Public key type/size only — no certificate identity or validity fields. See B4 for X.509 parsing.",
      },
    });
  }

  return observations;
}
