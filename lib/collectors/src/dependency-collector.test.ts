import { describe, expect, it } from "vitest";
import { DependencyCollector, collectDependencyObservations, lockfilesIn } from "./dependency-collector";
import { detectLockfileKind, parseLockfile, purlFor } from "./lockfiles";
import { LocationDetailSchema } from "./location-detail";
import { computeFingerprint, fingerprintForObservation } from "./fingerprint";
import type { CollectionTarget, RawObservation } from "./types";

/**
 * Fixtures are inline strings on purpose: the repo root's `preinstall` hook
 * deletes any `package-lock.json`/`yarn.lock` it finds (see package.json), so
 * a lockfile fixture committed as a real file is a trap for the next agent.
 */

function target(files: Array<{ path: string; content: string }>): CollectionTarget {
  return { kind: "source", repo: "acme/widget", files: files.map((f) => ({ ...f, language: "lockfile" })) };
}

function names(observations: RawObservation[]): string[] {
  return observations.map((o) => `${o.algorithm}@${o.location}`).sort();
}

const PNPM_LOCK_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      elliptic:
        specifier: ^6.5.4
        version: 6.5.4

packages:

  '@noble/ed25519@2.1.0':
    resolution: {integrity: sha512-fake==}
    engines: {node: '>=14.0.0'}

  elliptic@6.5.4:
    resolution: {integrity: sha512-fake==}

  node-rsa@1.1.1:
    resolution: {integrity: sha512-fake==}

  '@babel/core@7.29.0(supports-color@8.1.1)':
    resolution: {integrity: sha512-fake==}
    peerDependencies:
      '@types/react': '*'
      node-rsa: '>=1'
    peerDependenciesMeta:
      '@types/react':
        optional: true

snapshots:

  elliptic@6.5.4:
    dependencies:
      bn.js: 4.12.0
`;

describe("lockfile parsing — the shapes that break naive parsers", () => {
  it("reads pnpm-lock v9 keys, including quoted scoped names and peer-dependency suffixes", () => {
    const packages = parseLockfile("pnpm-lock", PNPM_LOCK_V9);
    expect(packages).toContainEqual({ name: "@noble/ed25519", version: "2.1.0" });
    expect(packages).toContainEqual({ name: "elliptic", version: "6.5.4" });
    // The peer suffix is pnpm resolution identity, not part of the version.
    expect(packages).toContainEqual({ name: "@babel/core", version: "7.29.0" });
    // `importers:` states specifiers, not resolved packages — it must not be read as one.
    expect(packages.some((p) => p.name === "." || p.name === "dependencies")).toBe(false);
    // A `peerDependencies:` key is indented six spaces inside a package block.
    // Found against the repo's own lockfile: without an exact-indent guard the
    // extra spaces are swallowed into the name and `'@types/react':` parses as
    // an installed package — and `node-rsa: '>=1'` there is a *requirement*,
    // not an installed version.
    expect(packages.some((p) => p.name.includes("@types/react"))).toBe(false);
    expect(packages.some((p) => p.name.trim() !== p.name || p.name.includes("'"))).toBe(false);
    expect(packages.filter((p) => p.name === "node-rsa")).toEqual([{ name: "node-rsa", version: "1.1.1" }]);
  });

  it("reads the older pnpm key shapes: v6 `/name@version` and v5 `/@scope/name/version`", () => {
    const v6 = "lockfileVersion: '6.0'\n\npackages:\n\n  /node-rsa@1.1.1:\n    resolution: {integrity: sha512-x==}\n";
    expect(parseLockfile("pnpm-lock", v6)).toContainEqual({ name: "node-rsa", version: "1.1.1" });

    const v5 = "lockfileVersion: 5.4\n\npackages:\n\n  /@noble/ed25519/1.7.3:\n    resolution: {integrity: sha512-x==}\n";
    expect(parseLockfile("pnpm-lock", v5)).toContainEqual({ name: "@noble/ed25519", version: "1.7.3" });
  });

  it("takes the LAST node_modules segment of a package-lock v3 path, and skips the root entry", () => {
    const content = JSON.stringify({
      name: "app",
      lockfileVersion: 3,
      packages: {
        "": { name: "app", dependencies: { elliptic: "^6.5.4" } },
        "node_modules/elliptic": { version: "6.5.4" },
        "node_modules/sshpk/node_modules/tweetnacl": { version: "0.14.5" },
        "node_modules/@noble/ed25519": { version: "2.1.0" },
        "lib/collectors": { resolved: "lib/collectors", link: true },
      },
    });
    const packages = parseLockfile("npm-lock", content);
    expect(packages).toContainEqual({ name: "elliptic", version: "6.5.4" });
    expect(packages).toContainEqual({ name: "tweetnacl", version: "0.14.5" });
    expect(packages).toContainEqual({ name: "@noble/ed25519", version: "2.1.0" });
    expect(packages.some((p) => p.name === "" || p.name === "lib/collectors")).toBe(false);
  });

  it("walks the recursive dependencies tree of a package-lock v1", () => {
    const content = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        sshpk: { version: "1.17.0", dependencies: { tweetnacl: { version: "0.14.5" } } },
      },
    });
    expect(parseLockfile("npm-lock", content)).toEqual([
      { name: "sshpk", version: "1.17.0" },
      { name: "tweetnacl", version: "0.14.5" },
    ]);
  });

  it("does not throw on a malformed lockfile — it contributes nothing", () => {
    expect(parseLockfile("npm-lock", "{ this is not json")).toEqual([]);
  });

  it("reads both yarn dialects: v1 multi-spec headers and berry `name@npm:range`", () => {
    const yarnV1 = [
      "# yarn lockfile v1",
      "",
      '"@noble/ed25519@^2.0.0", "@noble/ed25519@^2.1.0":',
      '  version "2.1.0"',
      '  resolved "https://registry.yarnpkg.com/@noble/ed25519/-/ed25519-2.1.0.tgz"',
      "",
      "elliptic@^6.5.4:",
      '  version "6.5.4"',
      "",
    ].join("\n");
    expect(parseLockfile("yarn-lock", yarnV1)).toEqual([
      { name: "@noble/ed25519", version: "2.1.0" },
      { name: "elliptic", version: "6.5.4" },
    ]);

    const berry = ['__metadata:', '  version: 6', '', '"elliptic@npm:^6.5.4":', "  version: 6.5.4", "  resolution: elliptic@npm:6.5.4", ""].join("\n");
    expect(parseLockfile("yarn-lock", berry)).toEqual([{ name: "elliptic", version: "6.5.4" }]);
  });

  it("pins a requirements.txt version only for `==`, leaving a range undetermined rather than guessing", () => {
    const requirements = [
      "# runtime deps",
      "-r base.txt",
      "--index-url https://pypi.example/simple",
      "cryptography==41.0.7  # pinned",
      "paramiko[gssapi]>=2.7,<3",
      'pynacl==1.5.0 ; python_version >= "3.8"',
      "pycryptodome==3.19.*",
      "rsa @ git+https://github.com/sybrenstuvel/python-rsa@main",
      "ecdsa==0.18.0 \\",
      "    --hash=sha256:deadbeef",
    ].join("\n");
    const packages = parseLockfile("pip-requirements", requirements);
    expect(packages).toContainEqual({ name: "cryptography", version: "41.0.7" });
    expect(packages).toContainEqual({ name: "paramiko", version: undefined });
    expect(packages).toContainEqual({ name: "pynacl", version: "1.5.0" });
    // A wildcard pin is a range, not a version.
    expect(packages).toContainEqual({ name: "pycryptodome", version: undefined });
    // PEP 508 direct reference: no version stated anywhere.
    expect(packages).toContainEqual({ name: "rsa", version: undefined });
    // Backslash continuation with a hash on the next line.
    expect(packages).toContainEqual({ name: "ecdsa", version: "0.18.0" });
    expect(packages.some((p) => p.name.startsWith("-"))).toBe(false);
  });

  it("recognises lockfiles by basename anywhere in the tree, and nothing else", () => {
    expect(detectLockfileKind("apps/web/pnpm-lock.yaml")).toBe("pnpm-lock");
    expect(detectLockfileKind("package-lock.json")).toBe("npm-lock");
    expect(detectLockfileKind("npm-shrinkwrap.json")).toBe("npm-lock");
    expect(detectLockfileKind("yarn.lock")).toBe("yarn-lock");
    expect(detectLockfileKind("requirements.txt")).toBe("pip-requirements");
    expect(detectLockfileKind("requirements-dev.txt")).toBe("pip-requirements");
    expect(detectLockfileKind("package.json")).toBeUndefined();
    expect(detectLockfileKind("src/elliptic.ts")).toBeUndefined();
  });
});

describe("DependencyCollector — B2", () => {
  it("maps a lockfile's packages to the algorithms they implement", async () => {
    const collector = new DependencyCollector();
    const observations: RawObservation[] = [];
    for await (const obs of collector.collect(target([{ path: "pnpm-lock.yaml", content: PNPM_LOCK_V9 }]), { organizationId: 1 })) {
      observations.push(obs);
    }

    expect(names(observations)).toEqual([
      "ECDH/DH@acme/widget:pkg:npm/elliptic",
      "ECDSA@acme/widget:pkg:npm/elliptic",
      "EdDSA@acme/widget:pkg:npm/%40noble/ed25519",
      "EdDSA@acme/widget:pkg:npm/elliptic",
      "RSA@acme/widget:pkg:npm/node-rsa",
    ]);
    // @babel/core is in the lockfile and is not a crypto library.
    expect(observations.every((o) => !o.location.includes("babel"))).toBe(true);
    for (const obs of observations) {
      expect(obs.discoveryModality).toBe("static_artifact_analysis");
      expect(() => LocationDetailSchema.parse(obs.locationDetail)).not.toThrow();
    }
    expect(collector.surface).toBe("dependency");
  });

  it("scores a single-purpose library above the regex collector's 0.7 and a general-purpose one below it", () => {
    const observations = collectDependencyObservations(target([{ path: "pnpm-lock.yaml", content: PNPM_LOCK_V9 }]));
    const dedicated = observations.find((o) => o.location === "acme/widget:pkg:npm/%40noble/ed25519");
    const multiPrimitive = observations.find((o) => o.location === "acme/widget:pkg:npm/elliptic" && o.algorithm === "EdDSA");

    // Parse-exact presence of a library that exists only to do Ed25519.
    expect(dedicated?.confidence).toBe(0.8);
    expect(dedicated?.evidence.evidenceTier).toBe("dedicated");
    // elliptic ships ECDSA, EdDSA and ECDH; which one the caller uses is not in the lockfile.
    expect(multiPrimitive?.confidence).toBe(0.5);
    expect(multiPrimitive?.evidence.evidenceTier).toBe("multi-primitive");
  });

  it("determines a key size only when the package pins one curve, and leaves an RSA library's modulus null", () => {
    const observations = collectDependencyObservations(target([{ path: "pnpm-lock.yaml", content: PNPM_LOCK_V9 }]));
    expect(observations.find((o) => o.location === "acme/widget:pkg:npm/%40noble/ed25519")?.keySize).toBe(256);
    // node-rsa says nothing about the modulus size the calling code will pick.
    expect(observations.find((o) => o.location === "acme/widget:pkg:npm/node-rsa")?.keySize).toBeUndefined();
    // elliptic is curve-agnostic for ECDSA.
    expect(observations.find((o) => o.location === "acme/widget:pkg:npm/elliptic" && o.algorithm === "ECDSA")?.keySize).toBeUndefined();
  });

  it("keeps the version out of `location` so a patch bump does not orphan and recreate the asset", () => {
    const before = collectDependencyObservations(target([{ path: "yarn.lock", content: 'node-rsa@^1.1.0:\n  version "1.1.1"\n' }]));
    const after = collectDependencyObservations(target([{ path: "yarn.lock", content: 'node-rsa@^1.1.0:\n  version "1.1.2"\n' }]));

    expect(before[0].location).toBe(after[0].location);
    expect(fingerprintOf(before[0])).toBe(fingerprintOf(after[0]));
    // The version is still recorded — it just lives where it is allowed to change.
    expect(before[0].locationDetail).toMatchObject({ dependency: { version: "1.1.1", purl: "pkg:npm/node-rsa@1.1.1" } });
    expect(after[0].evidence.version).toBe("1.1.2");
  });

  it("records an undetermined version as null rather than inventing one (G-05)", () => {
    const [observation] = collectDependencyObservations(target([{ path: "requirements.txt", content: "rsa>=4.0\n" }]));
    expect(observation.algorithm).toBe("RSA");
    expect(observation.location).toBe("acme/widget:pkg:pypi/rsa");
    expect(observation.evidence.version).toBeNull();
    expect((observation.locationDetail as { dependency: { version?: string } }).dependency.version).toBeUndefined();
    // No version means no version in the purl either — `pkg:pypi/rsa@unknown` would be a lie.
    expect((observation.locationDetail as { dependency: { purl?: string } }).dependency.purl).toBe("pkg:pypi/rsa");
  });

  it("normalises PyPI names per PEP 503 before looking them up", () => {
    const observations = collectDependencyObservations(target([{ path: "requirements.txt", content: "PyNaCl==1.5.0\nPyOpenSSL==24.0.0\n" }]));
    expect(observations.map((o) => o.location)).toContain("acme/widget:pkg:pypi/PyNaCl");
    expect(observations.some((o) => o.algorithm === "EdDSA" && o.keySize === 256)).toBe(true);
    expect(observations.some((o) => o.algorithm === "ECDH/DH" && o.keySize === 256)).toBe(true);
    expect(observations.some((o) => o.algorithm === "RSA")).toBe(true);
  });

  it("ignores files that are not lockfiles, however much crypto they name", () => {
    const observations = collectDependencyObservations(
      target([{ path: "src/keys.py", content: "import paramiko\nfrom cryptography.hazmat.primitives.asymmetric import rsa\n" }]),
    );
    expect(observations).toEqual([]);
    expect(lockfilesIn(target([{ path: "src/keys.py", content: "" }]))).toEqual([]);
  });

  it("emits one observation per distinct fact when two lockfiles agree, and two when they disagree", () => {
    const agree = collectDependencyObservations(
      target([
        { path: "pnpm-lock.yaml", content: "packages:\n\n  node-rsa@1.1.1:\n    resolution: {integrity: sha512-x==}\n" },
        { path: "apps/web/pnpm-lock.yaml", content: "packages:\n\n  node-rsa@1.1.1:\n    resolution: {integrity: sha512-x==}\n" },
      ]),
    );
    expect(agree).toHaveLength(1);
    expect(agree[0].evidence.lockfilePath).toBe("pnpm-lock.yaml");

    const disagree = collectDependencyObservations(
      target([
        { path: "pnpm-lock.yaml", content: "packages:\n\n  node-rsa@1.1.1:\n    resolution: {integrity: sha512-x==}\n" },
        { path: "apps/web/pnpm-lock.yaml", content: "packages:\n\n  node-rsa@1.0.0:\n    resolution: {integrity: sha512-x==}\n" },
      ]),
    );
    expect(disagree).toHaveLength(2);
  });

  it("does not infer an algorithm from a library whose algorithm is runtime configuration", () => {
    // jsonwebtoken/jose pick their algorithm from an `alg` value, so a lockfile
    // entry is no evidence for any particular one — deliberately unmapped.
    const observations = collectDependencyObservations(
      target([{ path: "yarn.lock", content: 'jsonwebtoken@^9.0.0:\n  version "9.0.2"\n\njose@^5.0.0:\n  version "5.2.0"\n' }]),
    );
    expect(observations).toEqual([]);
  });

  it("builds a purl that survives a round trip for a scoped npm package", () => {
    expect(purlFor("npm", "@noble/ed25519", "2.1.0")).toBe("pkg:npm/%40noble/ed25519@2.1.0");
    expect(purlFor("pypi", "pynacl")).toBe("pkg:pypi/pynacl");
  });
});

function fingerprintOf(observation: RawObservation): string {
  const input = fingerprintForObservation(observation, { repo: "acme/widget" });
  if (input === undefined) throw new Error("observation has no fingerprintable locationDetail");
  return computeFingerprint(input);
}
