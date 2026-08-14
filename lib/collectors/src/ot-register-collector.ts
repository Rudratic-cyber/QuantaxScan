import type { RawObservation } from "./types";

/**
 * B8 — turning a manually registered OT/embedded fleet into observations.
 *
 * Every other collector in this package reads evidence: a file, a lockfile, a
 * certificate, a handshake, a key export. This one reads a *statement a human
 * typed into a form*, which is why its modality is `manual_attestation` and its
 * confidence is the lowest in the product. It is still a collector in the sense
 * that matters — it produces `RawObservation`s that go through the same
 * fingerprint, the same ingest and the same lifecycle as everything else, so
 * the `ot` surface can honestly count as examined rather than sitting
 * permanently at never-examined while the register fills up.
 *
 * ## Why only the structured field becomes an asset
 *
 * `ot_fleets.cryptoInUse` is free text on purpose — "RSA-2048 firmware
 * signing, no TLS" — and this collector never reads it as an algorithm.
 * Parsing prose into a vocabulary term would be the guessing this product
 * refuses everywhere else, and writing the prose into `assets.algorithm` would
 * hand a sentence to the mapping engine and render it across the inventory and
 * the CBOM as an unmappable algorithm. So the asset comes from the *optional*
 * `cryptoAlgorithm` field, and a fleet described only in prose produces no
 * observation at all. The prose still travels, on `locationDetail`, where a
 * reader can see it beside the structured claim.
 *
 * The consequence is deliberate and worth stating: a register full of fleets
 * that nobody has given a structured algorithm produces no run and leaves the
 * surface never-examined. That is the correct reading — nothing about those
 * fleets' cryptography has been recorded in a form this system can reason
 * about, and saying otherwise would be the "examined, nothing found" lie the
 * coverage meter exists to prevent.
 */

/** The register fields this collector reads. A subset of the `ot_fleets` row, so `lib/collectors` needs no dependency on `@workspace/db`. */
export interface OtFleetInput {
  id: number;
  name: string;
  vendor?: string | null;
  model?: string | null;
  site?: string | null;
  deviceCount?: number | null;
  cryptoInUse?: string | null;
  /** The structured claim. Absent or blank means the customer stated nothing this system can inventory. */
  cryptoAlgorithm?: string | null;
  /** Undetermined stays undetermined — never an assumed size for the named algorithm (G-05). */
  cryptoKeySize?: number | null;
}

/**
 * Confidence for a registered fleet.
 *
 * Anchored explicitly against the scale `RawObservation.confidence` documents:
 * a completed TLS handshake is 1.0, a regex match on source is 0.7, a
 * single-purpose crypto dependency is 0.8. A person typing an algorithm into a
 * form is weaker than all of them — nothing was observed, and the claim is only
 * as good as the person's knowledge of their own estate. It is not zero either:
 * an operator naming the firmware-signing algorithm of a fleet they own is
 * real evidence, and usually the *only* evidence that will ever exist for a
 * device with no network interface to probe.
 *
 * Chosen, not measured — and deliberately below every automated collector so
 * that a register entry can never outrank an observation in any ranking built
 * on this number.
 */
export const OT_REGISTER_CONFIDENCE = 0.3;

/** Location prefix for every registered fleet. The ingest's reobservation scope is this prefix, because the register is a complete enumeration of the OT estate. */
export const OT_FLEET_LOCATION_PREFIX = "ot-fleet:";

/** The stable locator for a fleet's crypto. The register row is the identity — see `fingerprint.ts`'s `ot` variant. */
export function otFleetLocation(fleetId: number): string {
  return `${OT_FLEET_LOCATION_PREFIX}${fleetId}`;
}

/**
 * At most one observation per fleet: the register records one algorithm per
 * entry, and a fleet running two is two entries. Returns nothing when no
 * structured algorithm was supplied, which is what keeps an unstated fleet out
 * of the inventory entirely.
 */
export function observationsFromOtFleet(fleet: OtFleetInput): RawObservation[] {
  const stated = fleet.cryptoAlgorithm?.trim();
  if (!stated) return [];

  return [
    {
      // The customer's term, verbatim apart from surrounding whitespace. Not
      // mapped onto a canonical name here: `algorithms.json` is the mapping
      // engine's data and resolving against it is `lib/compliance.ts`'s job on
      // the way out, the same as for every other surface. A term the engine
      // does not recognise renders as "not mapped", which is the honest
      // outcome for a word only this customer used.
      algorithm: stated,
      keySize: fleet.cryptoKeySize ?? undefined,
      location: otFleetLocation(fleet.id),
      locationDetail: {
        kind: "ot" as const,
        ot: {
          fleetId: String(fleet.id),
          name: fleet.name,
          ...(fleet.vendor ? { vendor: fleet.vendor } : {}),
          ...(fleet.model ? { model: fleet.model } : {}),
          ...(fleet.site ? { site: fleet.site } : {}),
          ...(fleet.deviceCount != null ? { deviceCount: fleet.deviceCount } : {}),
          ...(fleet.cryptoInUse ? { cryptoInUse: fleet.cryptoInUse } : {}),
        },
      },
      discoveryModality: "manual_attestation",
      confidence: OT_REGISTER_CONFIDENCE,
      evidence: {
        fleetId: fleet.id,
        fleetName: fleet.name,
        statedAlgorithm: stated,
        note: "Recorded by hand in the OT register, not observed. See ot-register-collector.ts for why the free-text description is not read as an algorithm.",
      },
    },
  ];
}
