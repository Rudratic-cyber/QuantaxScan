import { describe, expect, it } from "vitest";
import cryptoPackagesData from "../../../docs/Claude/mappings/crypto-packages.json" with { type: "json" };
import {
  CONFIDENCE_BY_TIER,
  CRYPTO_PACKAGES,
  lookupCryptoPackage,
  statusOf,
  type CryptoPackageEntry,
} from "./crypto-packages";
import { collectDependencyObservations } from "./dependency-collector";
import type { CollectionTarget } from "./types";

/**
 * The provenance discipline `docs/Claude/mappings/` imposes on every other
 * standards claim in this project, applied to the package → algorithm table.
 *
 * It was exempt from that discipline for one reason only: it was TypeScript
 * rather than data. That exemption is what these tests remove — the same
 * mechanism as `lib/mappings/src/engine.test.ts`, which mutates cloned data
 * and asserts the output follows.
 */

const raw = cryptoPackagesData as unknown as {
  dataVersion: string;
  evidenceTiers: Record<string, { confidence: number }>;
  packages: CryptoPackageEntry[];
};

function target(files: Array<{ path: string; content: string }>): CollectionTarget {
  return { kind: "source", repo: "acme/widget", files: files.map((f) => ({ ...f, language: "lockfile" })) };
}

describe("every claim in the package table has provenance", () => {
  it("gives every package a status", () => {
    for (const entry of CRYPTO_PACKAGES) {
      expect(["verified", "needs-check"], `${entry.ecosystem}/${entry.name}`).toContain(entry.status);
    }
  });

  it("backs every `verified` claim with a dated, quoted citation", () => {
    for (const entry of CRYPTO_PACKAGES) {
      if (entry.status !== "verified") continue;
      const where = `${entry.ecosystem}/${entry.name}`;
      expect(entry.citation, where).toBeDefined();
      // A citation without a quote is the class of unverified claim G-07
      // punished: a plausible source URL attached to a remembered fact.
      expect(entry.citation?.quote, `${where} cites a source but quotes nothing from it`).toBeTruthy();
      expect(entry.citation?.retrievedAt, `${where} has no retrieval date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("never dates a `needs-check` claim", () => {
    // `check:standards` ages out every `retrievedAt` under mappings/. Putting
    // one on an unverified claim would buy it 180 days of looking checked,
    // which is the one failure that check cannot see.
    for (const entry of CRYPTO_PACKAGES) {
      const where = `${entry.ecosystem}/${entry.name}`;
      if (entry.status === "needs-check") {
        expect(entry.citation?.retrievedAt, `${where} is needs-check but carries a retrieval date`).toBeUndefined();
        expect(entry.needsCheckReason, `${where} is needs-check without saying why`).toBeTruthy();
      }
      for (const algorithm of entry.algorithms) {
        if (algorithm.status !== "needs-check") continue;
        expect(
          algorithm.needsCheckReason,
          `${where}'s ${algorithm.algorithm} claim is needs-check without saying why`,
        ).toBeTruthy();
      }
    }
  });

  it("lets a single claim be unverified inside an otherwise verified package", () => {
    // paramiko's own changelog removes ssh-dss in 4.0.0, and this table does
    // no version-range reasoning (G-21) — so the DSA claim is marked, and the
    // rest of the entry is not dragged down with it.
    const paramiko = lookupCryptoPackage("pypi", "paramiko");
    expect(paramiko?.status).toBe("verified");
    const dsa = paramiko!.algorithms.find((a) => a.algorithm === "DSA")!;
    expect(statusOf(paramiko!, dsa)).toBe("needs-check");
    expect(dsa.needsCheckReason).toContain("4.0.0");

    const ecdsa = paramiko!.algorithms.find((a) => a.algorithm === "ECDSA")!;
    expect(statusOf(paramiko!, ecdsa)).toBe("verified");
  });

  it("records the corrections the audit produced rather than quietly applying them", () => {
    // pyOpenSSL documents TYPE_RSA and TYPE_DSA and no EC key type; the old
    // hand-curated entry claimed ECDSA. A disproven claim is corrected, not
    // marked needs-check — but the removal is stated so it is reviewable.
    const pyopenssl = lookupCryptoPackage("pypi", "pyopenssl")!;
    expect(pyopenssl.algorithms.map((a) => a.algorithm)).toEqual(["RSA", "DSA"]);
    expect(pyopenssl.note).toContain("REMOVED");

    // python-ecdsa's own description names ECDSA, EdDSA and ECDH — it is a
    // general ECC library, so `dedicated` (0.8) overstated the inference.
    const ecdsa = lookupCryptoPackage("pypi", "ecdsa")!;
    expect(ecdsa.algorithms.map((a) => a.algorithm).sort()).toEqual(["ECDH", "ECDSA", "EdDSA"]);
    expect(ecdsa.algorithms.every((a) => a.tier === "multi-primitive")).toBe(true);
  });
});

describe("the confidence tiers are data", () => {
  it("reads both numbers from the JSON rather than declaring them in TypeScript", () => {
    expect(CONFIDENCE_BY_TIER.dedicated).toBe(raw.evidenceTiers["dedicated"].confidence);
    expect(CONFIDENCE_BY_TIER["multi-primitive"]).toBe(raw.evidenceTiers["multi-primitive"].confidence);
    // Pinned so a silent edit to either number has to be a deliberate one.
    expect(CONFIDENCE_BY_TIER).toEqual({ dedicated: 0.8, "multi-primitive": 0.5 });
  });
});

describe("a toolchain-ubiquitous package is flagged, not suppressed", () => {
  it("marks elliptic and sha.js, which land in nearly every JS project transitively", () => {
    expect(lookupCryptoPackage("npm", "elliptic")?.toolchainUbiquity).toBe(true);
    expect(lookupCryptoPackage("npm", "sha.js")?.toolchainUbiquity).toBe(true);
    // Not a suppression: the claims are still made, at the tier the evidence
    // supports. 0.5 describes the strength of "therefore this algorithm is
    // used", which ubiquity does not change.
    const elliptic = lookupCryptoPackage("npm", "elliptic")!;
    expect(elliptic.algorithms.every((a) => a.tier === "multi-primitive")).toBe(true);
  });

  it("does not flag a single-purpose library a project chose deliberately", () => {
    expect(lookupCryptoPackage("npm", "node-rsa")?.toolchainUbiquity).toBeUndefined();
  });
});

describe("provenance travels with the observation", () => {
  it("puts the status, the citation and the ubiquity flag in `evidence`", () => {
    const observations = collectDependencyObservations(
      target([{ path: "pnpm-lock.yaml", content: "packages:\n\n  elliptic@6.5.4:\n    resolution: {integrity: sha512-x==}\n" }]),
    );
    expect(observations.length).toBeGreaterThan(0);

    for (const observation of observations) {
      expect(observation.evidence["curationStatus"]).toBe("verified");
      expect(observation.evidence["toolchainUbiquity"]).toBe(true);
      const citation = observation.evidence["citation"] as { url?: string; quote?: string; retrievedAt?: string };
      expect(citation.url).toContain("elliptic");
      expect(citation.quote).toBeTruthy();
      expect(citation.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("says out loud when a claim is unverified", () => {
    const observations = collectDependencyObservations(
      target([{ path: "requirements.txt", content: "pycrypto==2.6.1\n" }]),
    );
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation.evidence["curationStatus"]).toBe("needs-check");
      expect(observation.evidence["needsCheckReason"]).toBeTruthy();
    }
  });
});
