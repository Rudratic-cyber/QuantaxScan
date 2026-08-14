import { createHash } from "node:crypto";
import type { RawObservation } from "./types";

/**
 * Deterministic asset fingerprint inputs, one variant per surface that
 * currently has a collector or a fully-specified rule.
 *
 * docs/Claude/04-architecture.md §"Asset fingerprint":
 *   source:      repo + path + algorithm + normalised-symbol (NOT line number)
 *   dependency:  repo + ecosystem + package + algorithm  (see below)
 *   tls:         repo + host + port + algorithm  (see below)
 *   certificate: repo + issuer + serial  (see below — same amendment as dependency)
 *   kms:         provider + key ARN/ID
 *
 * qx-sp1800-38b investigation report §"Binary fingerprint rule":
 *   managed binary: target-or-repository + packageIdentity-or-componentName
 *                   + artifactPath + binaryFormat + architecture + algorithm
 *                   + evidenceDiscriminator
 *
 * Anti-requirement (both sources): never include a line number or a content
 * digest/file hash in the fingerprint. A reformatted file or a routine
 * rebuilt binary must not orphan-and-recreate the asset — that renders as a
 * mass remediation followed by a mass regression in a trend chart.
 *
 * **`repo` was added to the `dependency` variant** when B2's ingest path was
 * built (the architecture table above lists `ecosystem + package + algorithm`
 * and is amended to match). Without it one asset row stands for a package
 * across every project in the organisation, and three mechanisms that key on
 * `assets.location` starting with `project:<id>:` break at once:
 * `DELETE /projects/:id` (which reconciles by that prefix and would delete a
 * package still present in another project, or leave it behind forever),
 * `GET /projects/:id/coverage` (which would find no dependency assets and
 * report the surface as examined-and-empty), and the CBOM export's
 * `containedIn` join. `location` is a single `notNull` column and cannot name
 * two projects, so the identity has to carry the project.
 *
 * It costs the estate-wide dedupe: `elliptic` in two projects is now two
 * rows, and "who uses elliptic" is a GROUP BY rather than a single asset.
 * That is the right trade — a query can aggregate rows, but no query can
 * split one row back into the two projects it stands for. Stability is
 * unaffected: `repo` is `project:<id>`, which does not change.
 *
 * **`repo` was added to the `tls` variant** for the identical reason, when
 * B3's ingest path was built: `POST /api/projects/:id/tls` is project-scoped
 * exactly like `POST /api/projects/:id/dependencies`, and without `repo` in
 * the identity, two different projects probing the same `host:port` would
 * fingerprint to the *same* row. The second project's ingest would then hit
 * the asset upsert's `ON CONFLICT (organizationId, fingerprint)` and silently
 * overwrite the first project's `location`, reassigning the asset to the
 * second project's `project:<id>:` prefix — the same bug the dependency
 * comment above describes, reproduced exactly, because it is the same root
 * cause: `assets.location` is one column and cannot carry two projects'
 * prefixes.
 *
 * **`repo` was added to the `certificate` variant for the identical reason,
 * when B4's ingest path was built.** The architecture table above still read
 * `issuer + serial` at the time; the same three mechanisms that motivated
 * `dependency`'s amendment apply verbatim to a certificate submitted to two
 * different projects — a shared wildcard certificate, or two projects
 * uploading the same CA bundle, would otherwise collide into one asset row
 * and the loser's `location` (and therefore its project attribution) would
 * be silently overwritten by the upsert. Unlike `dependency`, this was not
 * discovered as a live bug — B2's precedent made it obvious to apply up
 * front — but the reasoning, and the trade (one certificate now belongs to
 * exactly the project it was submitted under, not to the organisation at
 * large), is the same.
 *
 * **`config` (B6) is `repo + path + directive + algorithm + token`**, and the
 * architecture table above — which said `config` had no rule yet, because no
 * collector existed — is amended to match. It is deliberately the `source`
 * shape (`repo + path + …`) rather than the `certificate` shape: a
 * configuration file is a stable *slot* that gets edited in place, not a
 * minted artefact, so the file's path belongs in the identity and the asset
 * must survive an edit that leaves the declaration alone. `repo` is present
 * for the same reason it is on the three variants above, and needs no separate
 * argument.
 *
 * Two fields there deserve their own justification:
 *
 *  - **`directive`**, because the same token under two keywords is two
 *    different facts. `ssh-rsa` under `HostKeyAlgorithms` says the server
 *    authenticates itself with an RSA host key; under
 *    `PubkeyAcceptedAlgorithms` it says the server accepts RSA client keys.
 *    Remediating one does not remediate the other, so they cannot be one
 *    asset.
 *  - **`token`, alongside `algorithm`**, mirroring `source`'s `symbol`
 *    alongside `algorithm`. Without it, `Ciphers aes128-ctr,aes256-ctr`
 *    collapses to a single `AES` asset whose `keySize` is whichever token the
 *    ingest deduplication saw last — a 128-bit and a 256-bit cipher reported
 *    as the same thing, with the answer depending on list order. It also keeps
 *    `ssh-rsa` (SHA-1 signing) distinct from `rsa-sha2-512`, which is the
 *    difference an administrator actually acts on. The cost is more rows for a
 *    long algorithm list; the alternative is a row that is silently wrong.
 *
 * The token is *not* a content digest of the file (the anti-requirement
 * above): reformatting the file, moving the line, or changing an unrelated
 * directive leaves every fingerprint intact.
 */
export type FingerprintInput =
  | { surface: "source"; repo: string; path: string; algorithm: string; symbol: string }
  | { surface: "dependency"; repo: string; ecosystem: string; package: string; algorithm: string }
  | { surface: "tls"; repo: string; host: string; port: number; algorithm: string }
  | { surface: "certificate"; repo: string; issuer: string; serial: string }
  | { surface: "config"; repo: string; path: string; directive: string; algorithm: string; token: string }
  | { surface: "kms"; provider: string; keyId: string }
  | {
      surface: "binary";
      targetOrRepository: string;
      packageIdentityOrComponentName: string;
      artifactPath: string;
      binaryFormat: string;
      architecture: string;
      algorithm: string;
      evidenceDiscriminator: string;
    };

/**
 * Ordered, stable field list per surface. Order matters (it is part of the
 * hashed identity) but is fixed here rather than left to object-key
 * iteration order.
 */
function orderedFields(input: FingerprintInput): string[] {
  switch (input.surface) {
    case "source":
      return [input.surface, input.repo, input.path, input.algorithm, input.symbol];
    case "dependency":
      return [input.surface, input.repo, input.ecosystem, input.package, input.algorithm];
    case "tls":
      return [input.surface, input.repo, input.host, String(input.port), input.algorithm];
    case "certificate":
      return [input.surface, input.repo, input.issuer, input.serial];
    case "config":
      return [input.surface, input.repo, input.path, input.directive, input.algorithm, input.token];
    case "kms":
      return [input.surface, input.provider, input.keyId];
    case "binary":
      return [
        input.surface,
        input.targetOrRepository,
        input.packageIdentityOrComponentName,
        input.artifactPath,
        input.binaryFormat,
        input.architecture,
        input.algorithm,
        input.evidenceDiscriminator,
      ];
  }
}

/**
 * Compute the deterministic asset fingerprint. Fields are JSON-encoded as an
 * ordered array (not delimiter-joined) before hashing, so a field that
 * happens to contain the delimiter character cannot collide two distinct
 * inputs into the same fingerprint.
 */
export function computeFingerprint(input: FingerprintInput): string {
  const fields = orderedFields(input);
  const payload = JSON.stringify(fields);
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * The `RawObservation` → `FingerprintInput` bridge, and therefore the single
 * place that decides which surface an observation is persisted under.
 *
 * It exists because the ingest path used to hardcode `surface: "source"` in
 * its `computeFingerprint` call, which is why a second collector could be
 * built, tested and merged and still have nowhere to write: every observation
 * it produced would have been fingerprinted, and stored, as source code. The
 * surface is a property of the observation, so it is derived from the
 * observation — from `locationDetail`'s discriminator, which every collector
 * already sets and which the database validates on the way in.
 *
 * Returns `undefined` rather than guessing when the observation carries no
 * profile this can turn into an identity (`binary`, or no `locationDetail` at
 * all). A caller must decide what to do with that; the one thing it must not
 * do is fall back to a surface, which is the bug above.
 *
 * `repo` is the caller's stable target identity (`project:<id>` today), not
 * anything the collector chose — it is the same value the collector was
 * handed as `CollectionTarget.repo`, passed here explicitly so an ingest
 * cannot fingerprint a run against a target other than the one it scanned.
 *
 * **The `network` case maps unconditionally to `tls`, and that is a known,
 * temporary simplification — not a general disambiguation rule.**
 * `enums.ts`'s `LOCATION_DETAIL_KIND_VALUES` comment documents that `network`
 * is deliberately *shared* between the `tls` and `certificate` surfaces (both
 * observe the same SP 1800-38B host/port/CPE data elements), so `kind ===
 * "network"` alone cannot, in general, say which surface produced an
 * observation. It is safe to resolve that ambiguity in favour of `tls` right
 * now only because B3 (this collector) is the only thing that populates the
 * `network` profile as of this change — B4, the certificate collector, does
 * not exist yet. When it lands, this `case` needs an actual discriminator
 * (the two variants' identities are not even shaped alike: `tls` is `host +
 * port`, `certificate` is `issuer + serial`, which a `network` locationDetail
 * carries neither of), not a bigger conditional here. Until then, the ingest
 * path's existing `fingerprintInput.surface !== spec.surface` throw
 * (`asset-ingest.ts`) is the backstop: a future certificate collector that
 * reuses `network` without updating this function fails loudly on its first
 * ingest rather than silently landing on the `tls` surface.
 */
export function fingerprintForObservation(
  observation: RawObservation,
  context: { repo: string },
): FingerprintInput | undefined {
  const detail = observation.locationDetail;
  switch (detail?.kind) {
    case "source":
      return {
        surface: "source",
        repo: context.repo,
        path: detail.source.path,
        algorithm: observation.algorithm,
        // The matched symbol, falling back to the algorithm name — a
        // collector that reports no symbol still needs a stable identity.
        symbol: detail.source.symbol ?? observation.algorithm,
      };
    case "dependency":
      return {
        surface: "dependency",
        repo: context.repo,
        ecosystem: detail.dependency.ecosystem,
        package: detail.dependency.package,
        // Deliberately not the version: `location`/`locationDetail` carry it,
        // and folding it into identity would orphan and recreate the asset on
        // every patch bump — the same anti-requirement as line numbers above.
        algorithm: observation.algorithm,
      };
    case "certificate":
      return {
        surface: "certificate",
        repo: context.repo,
        issuer: detail.certificate.issuer,
        serial: detail.certificate.serialNumber,
      };
    case "config":
      return {
        surface: "config",
        repo: context.repo,
        path: detail.config.path,
        directive: detail.config.directive,
        algorithm: observation.algorithm,
        // The token verbatim. `strength` and `condition` are deliberately NOT
        // in the identity: an administrator wrapping an existing directive in
        // a `Match` block has narrowed where the same declaration applies, not
        // removed it and added a different one, and `locationDetail` already
        // carries the new condition on the next observation.
        token: detail.config.declaredValue,
      };
    case "network": {
      const { hostname, destinationPort } = detail.network;
      // Hard precondition of the `tls` variant, not a disambiguation
      // heuristic: `host + port + algorithm` cannot be built without both.
      // A future certificate observation that reuses `network` but omits a
      // port (a certificate is not inherently tied to one) is correctly
      // rejected here rather than mis-fingerprinted as `tls`.
      if (hostname === undefined || destinationPort === undefined) return undefined;
      return {
        surface: "tls",
        repo: context.repo,
        host: hostname,
        port: destinationPort,
        algorithm: observation.algorithm,
      };
    }
    default:
      return undefined;
  }
}
