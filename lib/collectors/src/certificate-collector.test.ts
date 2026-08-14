import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CERTIFICATE_KEY_ALGORITHMS,
  CertificateCollector,
  certificatesIn,
  collectCertificateObservations,
} from "./certificate-collector";
import { LocationDetailSchema } from "./location-detail";
import { computeFingerprint, fingerprintForObservation } from "./fingerprint";
import type { CollectionTarget, RawObservation } from "./types";

/**
 * Certificates are generated at test time with the system `openssl` binary,
 * never committed: the lane brief that specified this collector is explicit
 * that no fixture here should be key material sitting in the repository,
 * even a throwaway test one. This mirrors `tests/e2e/04-certificates.spec.ts`,
 * which generates its own certificates the same way.
 */
interface CertSpec {
  keyAlgorithm: "rsa" | "ec" | "ed25519";
  curve?: string;
  bits?: number;
  days?: number;
  cn?: string;
}

function generateSelfSignedCertPem(spec: CertSpec): string {
  const dir = mkdtempSync(join(tmpdir(), "qx-cert-test-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    const newkeyArg =
      spec.keyAlgorithm === "rsa" ? `rsa:${spec.bits ?? 2048}` : spec.keyAlgorithm === "ec" ? "ec" : "ed25519";
    const args = [
      "req",
      "-x509",
      "-newkey",
      newkeyArg,
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      String(spec.days ?? 365),
      "-nodes",
      "-subj",
      `/CN=${spec.cn ?? "test.invalid"}/O=QuantaXscan Test`,
    ];
    if (spec.keyAlgorithm === "ec") {
      args.push("-pkeyopt", `ec_paramgen_curve:${spec.curve ?? "P-256"}`);
    }
    execFileSync("openssl", args, { stdio: "pipe" });
    return readFileSync(certPath, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function target(files: Array<{ path: string; content: string }>, repo = "acme/widget"): CollectionTarget {
  return { kind: "source", repo, files: files.map((f) => ({ ...f, language: "certificate" })) };
}

let rsaCertPem: string;
let ecCertPem: string;
let ed25519CertPem: string;

beforeAll(() => {
  rsaCertPem = generateSelfSignedCertPem({ keyAlgorithm: "rsa", bits: 2048, cn: "rsa.example.invalid" });
  ecCertPem = generateSelfSignedCertPem({ keyAlgorithm: "ec", curve: "P-384", cn: "ec.example.invalid" });
  ed25519CertPem = generateSelfSignedCertPem({ keyAlgorithm: "ed25519", cn: "ed25519.example.invalid" });
});

describe("collectCertificateObservations — RSA", () => {
  it("reports the canonical algorithm and the actual modulus size", () => {
    const [obs] = collectCertificateObservations(target([{ path: "server.pem", content: rsaCertPem }]));
    expect(obs.algorithm).toBe("RSA");
    expect(obs.keySize).toBe(2048);
    expect(obs.discoveryModality).toBe("static_artifact_analysis");
    expect(obs.confidence).toBeGreaterThan(0.8);
    expect(obs.confidence).toBeLessThan(1);
  });

  it("carries issuer/serial/notBefore/notAfter/signatureAlgorithm in a schema-valid locationDetail", () => {
    const [obs] = collectCertificateObservations(target([{ path: "server.pem", content: rsaCertPem }]));
    const parsed = LocationDetailSchema.parse(obs.locationDetail);
    expect(parsed.kind).toBe("certificate");
    if (parsed.kind !== "certificate") throw new Error("unreachable");
    expect(parsed.certificate.issuer).toContain("rsa.example.invalid");
    expect(parsed.certificate.serialNumber).toMatch(/^[0-9A-F]+$/);
    expect(new Date(parsed.certificate.notBefore).getTime()).not.toBeNaN();
    expect(new Date(parsed.certificate.notAfter).getTime()).toBeGreaterThan(new Date(parsed.certificate.notBefore).getTime());
    expect(parsed.certificate.signatureAlgorithm).toMatch(/rsa/i);
  });

  it("location is scoped by repo, issuer and serial — not a content hash or a file path", () => {
    const [obs] = collectCertificateObservations(target([{ path: "anything.pem", content: rsaCertPem }], "project:1"));
    expect(obs.location.startsWith("project:1:cert:")).toBe(true);
  });
});

describe("collectCertificateObservations — EC", () => {
  it("resolves the named curve's bit size via curveBitSize, not the RSA modulus path", () => {
    const [obs] = collectCertificateObservations(target([{ path: "ec.pem", content: ecCertPem }]));
    expect(obs.algorithm).toBe("ECDSA");
    expect(obs.keySize).toBe(384); // P-384
  });
});

describe("collectCertificateObservations — Ed25519", () => {
  it("maps to EdDSA with the curve's fixed bit size, sourced from asymmetricKeyType directly", () => {
    const [obs] = collectCertificateObservations(target([{ path: "ed.pem", content: ed25519CertPem }]));
    expect(obs.algorithm).toBe("EdDSA");
    expect(obs.keySize).toBe(256);
  });
});

describe("collectCertificateObservations — PEM bundles", () => {
  it("reads every certificate in a multi-cert PEM file, not just the first", () => {
    // Node's X509Certificate constructor silently parses only the first
    // certificate when handed a concatenated PEM bundle, with no error and no
    // signal anything was dropped. This is the regression that guards against
    // that footgun being reintroduced by a future refactor that stops
    // splitting on the BEGIN/END markers first.
    const bundle = rsaCertPem + ecCertPem;
    const observations = collectCertificateObservations(target([{ path: "chain.pem", content: bundle }]));
    expect(observations).toHaveLength(2);
    expect(observations.map((o) => o.algorithm).sort()).toEqual(["ECDSA", "RSA"]);
  });
});

describe("collectCertificateObservations — DER", () => {
  it("reads a base64-encoded DER certificate identically to its PEM form", () => {
    const der = Buffer.from(
      rsaCertPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, ""),
      "base64",
    );
    const base64Der = der.toString("base64");
    const [fromDer] = collectCertificateObservations(target([{ path: "cert.der.b64", content: base64Der }]));
    const [fromPem] = collectCertificateObservations(target([{ path: "cert.pem", content: rsaCertPem }]));
    expect(fromDer.algorithm).toBe(fromPem.algorithm);
    expect(fromDer.keySize).toBe(fromPem.keySize);
    expect(fromDer.location).toBe(fromPem.location);
  });
});

describe("collectCertificateObservations — malformed input", () => {
  it("contributes zero observations for content that is neither PEM nor decodable DER, rather than guessing", () => {
    const observations = collectCertificateObservations(target([{ path: "notes.txt", content: "just some prose, not a certificate" }]));
    expect(observations).toEqual([]);
  });

  it("does not throw on an empty or truncated PEM block", () => {
    expect(() =>
      collectCertificateObservations(target([{ path: "broken.pem", content: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----" }])),
    ).not.toThrow();
  });
});

describe("certificatesIn — detection", () => {
  it("counts certificates per file, matching what collectCertificateObservations actually reads", () => {
    const files = [
      { path: "server.pem", content: rsaCertPem },
      { path: "chain.pem", content: rsaCertPem + ecCertPem },
      { path: "readme.md", content: "not a certificate" },
    ];
    const recognised = certificatesIn(target(files));
    expect(recognised).toEqual([
      { path: "server.pem", certificateCount: 1 },
      { path: "chain.pem", certificateCount: 2 },
    ]);
  });
});

describe("CERTIFICATE_KEY_ALGORITHMS", () => {
  it("names every canonical algorithm this collector can emit", () => {
    expect(CERTIFICATE_KEY_ALGORITHMS).toEqual(expect.arrayContaining(["RSA", "ECDSA", "EdDSA", "DSA", "ECDH/DH"]));
  });
});

describe("fingerprintForObservation — certificate", () => {
  function fingerprintOf(observation: RawObservation, repo: string): string {
    const input = fingerprintForObservation(observation, { repo });
    if (input === undefined) throw new Error("observation has no fingerprintable locationDetail");
    return computeFingerprint(input);
  }

  it("is stable for the same certificate re-submitted to the same project", () => {
    const [a] = collectCertificateObservations(target([{ path: "one.pem", content: rsaCertPem }], "project:1"));
    const [b] = collectCertificateObservations(target([{ path: "two.pem", content: rsaCertPem }], "project:1"));
    // Different submitted paths, same certificate bytes — the fingerprint
    // (issuer + serial, not the file path) must agree.
    expect(fingerprintOf(a, "project:1")).toBe(fingerprintOf(b, "project:1"));
  });

  it("differs for the same certificate submitted under two different projects", () => {
    const [a] = collectCertificateObservations(target([{ path: "cert.pem", content: rsaCertPem }], "project:1"));
    const [b] = collectCertificateObservations(target([{ path: "cert.pem", content: rsaCertPem }], "project:2"));
    expect(fingerprintOf(a, "project:1")).not.toBe(fingerprintOf(b, "project:2"));
  });

  it("differs for two distinct certificates in the same project", () => {
    const [rsa] = collectCertificateObservations(target([{ path: "a.pem", content: rsaCertPem }], "project:1"));
    const [ec] = collectCertificateObservations(target([{ path: "b.pem", content: ecCertPem }], "project:1"));
    expect(fingerprintOf(rsa, "project:1")).not.toBe(fingerprintOf(ec, "project:1"));
  });
});

describe("CertificateCollector", () => {
  it("implements the shared Collector contract and yields the same observations as the pure function", async () => {
    const collector = new CertificateCollector();
    expect(collector.surface).toBe("certificate");

    const t = target([{ path: "server.pem", content: rsaCertPem }]);
    const yielded: RawObservation[] = [];
    for await (const obs of collector.collect(t, { organizationId: 1 })) yielded.push(obs);

    expect(yielded).toEqual(collectCertificateObservations(t));
  });
});
