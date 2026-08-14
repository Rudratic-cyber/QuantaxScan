import { describe, expect, it } from "vitest";
import { computeFingerprint } from "./fingerprint";

describe("computeFingerprint — source surface", () => {
  it("is stable across repeated calls with the same inputs", () => {
    const input = { surface: "source" as const, repo: "acme/widget", path: "src/keys.py", algorithm: "RSA", symbol: "RSA" };
    expect(computeFingerprint(input)).toBe(computeFingerprint(input));
  });

  it("does NOT change when a line number changes — the anti-requirement", () => {
    // Line number is not part of FingerprintInput at all: this test asserts
    // the type-level guarantee by construction, and that two otherwise
    // identical inputs (as if the surrounding file had been reformatted,
    // shifting every subsequent line) produce the same fingerprint.
    const before = { surface: "source" as const, repo: "acme/widget", path: "src/keys.py", algorithm: "RSA", symbol: "RSA" };
    const afterReformat = { surface: "source" as const, repo: "acme/widget", path: "src/keys.py", algorithm: "RSA", symbol: "RSA" };
    expect(computeFingerprint(before)).toBe(computeFingerprint(afterReformat));
  });

  it("changes when the path changes", () => {
    const a = computeFingerprint({ surface: "source", repo: "acme/widget", path: "src/keys.py", algorithm: "RSA", symbol: "RSA" });
    const b = computeFingerprint({ surface: "source", repo: "acme/widget", path: "src/other.py", algorithm: "RSA", symbol: "RSA" });
    expect(a).not.toBe(b);
  });

  it("changes when the algorithm changes", () => {
    const a = computeFingerprint({ surface: "source", repo: "acme/widget", path: "src/keys.py", algorithm: "RSA", symbol: "RSA" });
    const b = computeFingerprint({ surface: "source", repo: "acme/widget", path: "src/keys.py", algorithm: "ECDSA", symbol: "ECDSA" });
    expect(a).not.toBe(b);
  });

  it("does not collide two distinct inputs via delimiter injection", () => {
    // If fields were naively joined with "|", repo="a|b" + path="c" could
    // collide with repo="a" + path="b|c". JSON-encoding as an ordered array
    // must prevent this.
    const a = computeFingerprint({ surface: "source", repo: "a|b", path: "c", algorithm: "RSA", symbol: "RSA" });
    const b = computeFingerprint({ surface: "source", repo: "a", path: "b|c", algorithm: "RSA", symbol: "RSA" });
    expect(a).not.toBe(b);
  });
});

describe("computeFingerprint — other surfaces", () => {
  it("dependency: repo + ecosystem + package + algorithm, ignores version", () => {
    const a = computeFingerprint({ surface: "dependency", repo: "project:1", ecosystem: "npm", package: "left-pad", algorithm: "RSA" });
    const b = computeFingerprint({ surface: "dependency", repo: "project:1", ecosystem: "npm", package: "left-pad", algorithm: "RSA" });
    expect(a).toBe(b);
  });

  it("dependency: the same package in two projects is two assets", () => {
    // `repo` is in the identity because `assets.location` is a single column
    // and three mechanisms attribute an asset to a project by its
    // `project:<id>:` prefix — project deletion, the D3 coverage meter and the
    // CBOM `containedIn` join. One row cannot carry two projects' prefixes.
    const one = computeFingerprint({ surface: "dependency", repo: "project:1", ecosystem: "npm", package: "elliptic", algorithm: "ECDSA" });
    const two = computeFingerprint({ surface: "dependency", repo: "project:2", ecosystem: "npm", package: "elliptic", algorithm: "ECDSA" });
    expect(one).not.toBe(two);
  });

  it("tls: host + port + algorithm", () => {
    const a = computeFingerprint({ surface: "tls", host: "example.com", port: 443, algorithm: "ECDSA" });
    const b = computeFingerprint({ surface: "tls", host: "example.com", port: 8443, algorithm: "ECDSA" });
    expect(a).not.toBe(b);
  });

  it("certificate: repo + issuer + serial", () => {
    const a = computeFingerprint({ surface: "certificate", repo: "project:1", issuer: "DigiCert", serial: "01AB" });
    const b = computeFingerprint({ surface: "certificate", repo: "project:1", issuer: "DigiCert", serial: "01AB" });
    expect(a).toBe(b);
  });

  it("certificate: the same issuer+serial submitted to two projects is two assets", () => {
    // Same reasoning as the dependency case above: `assets.location` carries
    // only one project's prefix, so a shared certificate (a wildcard cert
    // reused across projects, or the same CA bundle uploaded twice) must not
    // collide into one row — the second upsert would silently overwrite the
    // first project's `location` and un-attribute its certificate.
    const one = computeFingerprint({ surface: "certificate", repo: "project:1", issuer: "DigiCert", serial: "01AB" });
    const two = computeFingerprint({ surface: "certificate", repo: "project:2", issuer: "DigiCert", serial: "01AB" });
    expect(one).not.toBe(two);
  });

  it("binary: excludes content digest/sha256 by construction — the type has no such field", () => {
    const a = computeFingerprint({
      surface: "binary",
      targetOrRepository: "acme/widget-image",
      packageIdentityOrComponentName: "libssl",
      artifactPath: "/usr/lib/libssl.so.3",
      binaryFormat: "elf",
      architecture: "x86_64",
      algorithm: "RSA",
      evidenceDiscriminator: "rule-libssl-rsa-import",
    });
    const b = computeFingerprint({
      surface: "binary",
      targetOrRepository: "acme/widget-image",
      packageIdentityOrComponentName: "libssl",
      artifactPath: "/usr/lib/libssl.so.3",
      binaryFormat: "elf",
      architecture: "x86_64",
      algorithm: "RSA",
      evidenceDiscriminator: "rule-libssl-rsa-import",
    });
    // A routine rebuild changes the binary's content digest but not any of
    // these fields, so the fingerprint (and therefore the asset) is stable.
    expect(a).toBe(b);
  });
});
