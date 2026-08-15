import { describe, expect, it } from "vitest";
import { collectDependencyObservations, dependencyLocationPrefix, ecosystemsIn, lockfilesIn } from "./dependency-collector";
import { computeFingerprint, fingerprintForObservation } from "./fingerprint";
import { ECOSYSTEM_VALUES, LOCKFILE_KINDS, detectLockfileKind, parseLockfile, purlFor } from "./lockfiles";
import { LocationDetailSchema } from "./location-detail";
import type { CollectionTarget, RawObservation } from "./types";

/**
 * B2's four back-end ecosystems: Java (Maven/Gradle), Go, .NET (NuGet) and
 * Rust (Cargo). npm and PyPI are covered by `dependency-collector.test.ts`;
 * this file is about the formats those two never exercised.
 *
 * Fixtures are inline strings for the same reason as in that file — the repo
 * root's `preinstall` hook deletes lockfiles it finds on disk — and each one
 * is cut down from the real thing rather than invented, so the shapes that
 * break a naive reader are all present: a Maven version that is a `${property}`
 * reference, a `<dependencyManagement>` block that declares a version without
 * taking the dependency, a `go.sum` `/go.mod` hash line, a `!`-escaped Go
 * module path, a NuGet `requested` range next to a `resolved` pin, and a
 * `.csproj` under central package management with no version at all.
 *
 * The assertion that matters most is the last one in this file: two files in
 * one repository naming the same dependency must produce **one** asset. Every
 * other failure here is visible; that one renders as a double-counted
 * inventory with no error anywhere.
 */

function target(files: Array<{ path: string; content: string }>): CollectionTarget {
  return { kind: "source", repo: "acme/widget", files: files.map((f) => ({ ...f, language: "lockfile" })) };
}

function names(observations: RawObservation[]): string[] {
  return observations.map((o) => `${o.algorithm}@${o.location}`).sort();
}

function fingerprintOf(observation: RawObservation): string {
  const input = fingerprintForObservation(observation, { repo: "acme/widget" });
  if (input === undefined) throw new Error("observation has no fingerprintable locationDetail");
  return computeFingerprint(input);
}

/* ------------------------------------------------------------------ *
 * Java
 * ------------------------------------------------------------------ */

const POM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.2</version>
  </parent>
  <groupId>com.acme</groupId>
  <artifactId>widget</artifactId>
  <version>1.0.0-SNAPSHOT</version>

  <properties>
    <bc.version>1.78.1</bc.version>
  </properties>

  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.google.crypto.tink</groupId>
        <artifactId>tink</artifactId>
        <version>1.14.0</version>
      </dependency>
    </dependencies>
  </dependencyManagement>

  <dependencies>
    <dependency>
      <groupId>org.bouncycastle</groupId>
      <artifactId>bcprov-jdk18on</artifactId>
      <version>\${bc.version}</version>
    </dependency>
    <!-- Version comes from the dependencyManagement block above. -->
    <dependency>
      <groupId>com.google.crypto.tink</groupId>
      <artifactId>tink</artifactId>
    </dependency>
    <!--
    <dependency>
      <groupId>net.i2p.crypto</groupId>
      <artifactId>eddsa</artifactId>
      <version>0.3.0</version>
    </dependency>
    -->
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.13</version>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-shade-plugin</artifactId>
        <version>3.5.3</version>
        <dependencies>
          <dependency>
            <groupId>org.bouncycastle</groupId>
            <artifactId>bcpg-jdk18on</artifactId>
            <version>1.78.1</version>
          </dependency>
        </dependencies>
      </plugin>
    </plugins>
  </build>
</project>
`;

const GRADLE_LOCKFILE = `# This is a Gradle generated file for dependency locking.
# Manual edits can break the build and are not advised.
# This file is expected to be part of source control.
com.google.crypto.tink:tink:1.14.0=compileClasspath,runtimeClasspath
net.i2p.crypto:eddsa:0.3.0=compileClasspath,runtimeClasspath
org.bouncycastle:bcprov-jdk18on:1.78.1=compileClasspath,runtimeClasspath
org.slf4j:slf4j-api:2.0.13=compileClasspath,runtimeClasspath
empty=annotationProcessor,testAnnotationProcessor
`;

const BUILD_GRADLE = `plugins {
    id 'java'
}

description 'A widget that talks to org.bouncycastle:bcpg-jdk18on over the wire'

dependencies {
    implementation 'org.bouncycastle:bcprov-jdk18on:1.78.1'
    implementation("net.i2p.crypto:eddsa:0.3.0")
    // implementation 'com.google.crypto.tink:tink:1.14.0'
    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.2'
    implementation "org.example:configured:\${exampleVersion}"
    implementation group: 'org.apache.commons', name: 'commons-lang3', version: '3.14.0'
}
`;

describe("Java — Maven and Gradle", () => {
  it("reads a pom's real dependencies and resolves a version property", () => {
    const packages = parseLockfile("maven-pom", POM_XML);
    expect(packages).toContainEqual({ name: "org.bouncycastle:bcprov-jdk18on", version: "1.78.1" });
    expect(packages).toContainEqual({ name: "org.slf4j:slf4j-api", version: "2.0.13" });
  });

  it("records a BOM-managed dependency with no version rather than borrowing dependencyManagement's", () => {
    // The version in <dependencyManagement> applies only if this module's
    // effective POM resolves to it, which needs the parent POM this file does
    // not contain. Copying it across would state a pin nobody wrote here.
    expect(parseLockfile("maven-pom", POM_XML)).toContainEqual({ name: "com.google.crypto.tink:tink", version: undefined });
  });

  it("ignores <parent>, <build> plugins and commented-out dependencies", () => {
    const names = parseLockfile("maven-pom", POM_XML).map((p) => p.name);
    // A parent POM is a coordinate, not a jar on the classpath.
    expect(names).not.toContain("org.springframework.boot:spring-boot-starter-parent");
    // A shade-plugin dependency is build tooling and is not shipped.
    expect(names).not.toContain("org.bouncycastle:bcpg-jdk18on");
    // Commented out is not declared.
    expect(names).not.toContain("net.i2p.crypto:eddsa");
  });

  it("reads gradle.lockfile's coordinate=configuration lines and skips its `empty=` line", () => {
    const packages = parseLockfile("gradle-lock", GRADLE_LOCKFILE);
    expect(packages).toContainEqual({ name: "org.bouncycastle:bcprov-jdk18on", version: "1.78.1" });
    expect(packages).toContainEqual({ name: "net.i2p.crypto:eddsa", version: "0.3.0" });
    expect(packages.map((p) => p.name)).not.toContain("empty");
  });

  it("reads only build.gradle's unambiguous single-literal declarations", () => {
    const packages = parseLockfile("gradle-build", BUILD_GRADLE);
    expect(packages).toContainEqual({ name: "org.bouncycastle:bcprov-jdk18on", version: "1.78.1" });
    expect(packages).toContainEqual({ name: "net.i2p.crypto:eddsa", version: "0.3.0" });
    // A build file is a program. `description '...'` is not a configuration
    // name, so the coordinate inside that prose is not a dependency.
    expect(packages.map((p) => p.name)).not.toContain("org.bouncycastle:bcpg-jdk18on");
    // Commented out is not declared.
    expect(packages.map((p) => p.name)).not.toContain("com.google.crypto.tink:tink");
    // Map notation is skipped rather than guessed at — fewer observations, never wrong ones.
    expect(packages.map((p) => p.name)).not.toContain("org.apache.commons:commons-lang3");
  });

  it("never reports a Gradle interpolated version as a literal one", () => {
    const configured = parseLockfile("gradle-build", BUILD_GRADLE).find((p) => p.name === "org.example:configured");
    expect(configured).toBeDefined();
    expect(configured?.version).toBeUndefined();
  });

  it("maps a Java lockfile to the algorithms its libraries implement", () => {
    const observations = collectDependencyObservations(target([{ path: "gradle.lockfile", content: GRADLE_LOCKFILE }]));
    expect(names(observations)).toEqual([
      "ECDH/DH@acme/widget:pkg:maven/org.bouncycastle/bcprov-jdk18on",
      "ECDSA@acme/widget:pkg:maven/com.google.crypto.tink/tink",
      "ECDSA@acme/widget:pkg:maven/org.bouncycastle/bcprov-jdk18on",
      "EdDSA@acme/widget:pkg:maven/com.google.crypto.tink/tink",
      "EdDSA@acme/widget:pkg:maven/net.i2p.crypto/eddsa",
      "EdDSA@acme/widget:pkg:maven/org.bouncycastle/bcprov-jdk18on",
      "RSA@acme/widget:pkg:maven/com.google.crypto.tink/tink",
      "RSA@acme/widget:pkg:maven/org.bouncycastle/bcprov-jdk18on",
      "DSA@acme/widget:pkg:maven/org.bouncycastle/bcprov-jdk18on",
    ].sort());
    // slf4j is in the file and is not a crypto library.
    expect(observations.every((o) => !o.location.includes("slf4j"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Go
 * ------------------------------------------------------------------ */

const GO_MOD = `module github.com/acme/widget

go 1.22

require (
	github.com/btcsuite/btcd/btcec/v2 v2.3.4
	github.com/decred/dcrd/dcrec/secp256k1/v4 v4.3.0 // indirect
	github.com/!burnt!sushi/toml v1.4.0
)

require github.com/cloudflare/circl v1.3.9

replace github.com/decred/dcrd/dcrec/secp256k1/v4 => ../local-secp256k1

exclude github.com/stretchr/testify v1.8.0
`;

const GO_SUM = `github.com/btcsuite/btcd/btcec/v2 v2.3.4 h1:3EJjcN70HCu/mwqlUsGK8GcNVyLVxFDlWurTXGPFfiQ=
github.com/btcsuite/btcd/btcec/v2 v2.3.4/go.mod h1:zYzJ8etWJQIv1Ogk7OzpWjowwOdXY1W/17j2MW85J04=
github.com/cloudflare/circl v1.3.9 h1:QFrlgFYf2Qpi8bSpVPK1HBvWpx16DQKq/RhOfLhLwGA=
github.com/cloudflare/circl v1.3.9/go.mod h1:PXKa3fO4XvJfB+95vCkVvyOe6ZTF3pJEHrjNiTRLKKM=
`;

describe("Go — go.mod and go.sum", () => {
  it("reads require blocks and single-line requires, and un-escapes an upper-cased module path", () => {
    const packages = parseLockfile("go-mod", GO_MOD);
    expect(packages).toContainEqual({ name: "github.com/btcsuite/btcd/btcec/v2", version: "v2.3.4" });
    expect(packages).toContainEqual({ name: "github.com/cloudflare/circl", version: "v1.3.9" });
    // go.sum lower-cases with `!` escapes; go.mod does not. One dependency, one spelling.
    expect(packages).toContainEqual({ name: "github.com/BurntSushi/toml", version: "v1.4.0" });
  });

  it("ignores the module line, replace and exclude directives", () => {
    const names = parseLockfile("go-mod", GO_MOD).map((p) => p.name);
    expect(names).not.toContain("github.com/acme/widget");
    expect(names).not.toContain("github.com/stretchr/testify");
    // `replace` names a module that is *not* what gets built, so a require it
    // rewrites must not be reported twice.
    expect(names.filter((n) => n === "github.com/decred/dcrd/dcrec/secp256k1/v4")).toHaveLength(1);
  });

  it("strips the /go.mod suffix off a go.sum hash line rather than reporting it as a version", () => {
    const packages = parseLockfile("go-sum", GO_SUM);
    expect(packages.every((p) => !p.version?.includes("/go.mod"))).toBe(true);
    expect(packages).toContainEqual({ name: "github.com/cloudflare/circl", version: "v1.3.9" });
  });

  it("matches a module regardless of its major-version suffix", () => {
    const observations = collectDependencyObservations(target([{ path: "go.mod", content: GO_MOD }]));
    // The table holds `github.com/btcsuite/btcd/btcec`; the module path says `/v2`.
    expect(names(observations)).toContain("ECDSA@acme/widget:pkg:golang/github.com/btcsuite/btcd/btcec/v2");
    expect(names(observations)).toContain("ECDSA@acme/widget:pkg:golang/github.com/decred/dcrd/dcrec/secp256k1/v4");
  });

  it("keeps a Go module path's slashes as purl separators", () => {
    expect(purlFor("golang", "github.com/cloudflare/circl", "v1.3.9")).toBe("pkg:golang/github.com/cloudflare/circl@v1.3.9");
  });

  it("resolves a curve to a key size only where the package pins one", () => {
    const observations = collectDependencyObservations(target([{ path: "go.mod", content: GO_MOD }]));
    const btcec = observations.find((o) => o.location.includes("btcec"));
    expect(btcec?.keySize).toBe(256); // secp256k1
    // CIRCL ships Ed25519 *and* Ed448, so no curve is pinned and no size is claimed.
    const circl = observations.find((o) => o.location.includes("circl") && o.algorithm === "EdDSA");
    expect(circl?.keySize).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * .NET
 * ------------------------------------------------------------------ */

const PACKAGES_LOCK_JSON = `{
  "version": 1,
  "dependencies": {
    "net8.0": {
      "BouncyCastle.Cryptography": {
        "type": "Direct",
        "requested": "[2.4.0, )",
        "resolved": "2.4.0",
        "contentHash": "abc="
      },
      "NSec.Cryptography": {
        "type": "Transitive",
        "resolved": "24.4.0",
        "contentHash": "def="
      },
      "Serilog": {
        "type": "Direct",
        "requested": "[4.0.0, )",
        "resolved": "4.0.0",
        "contentHash": "ghi="
      }
    }
  }
}
`;

const PACKAGES_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<packages>
  <package id="Portable.BouncyCastle" version="1.9.0" targetFramework="net472" />
  <!-- <package id="NSec.Cryptography" version="20.2.0" targetFramework="net472" /> -->
  <package id="Newtonsoft.Json" version="13.0.3" targetFramework="net472" />
</packages>
`;

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <!-- Central package management: the version lives in Directory.Packages.props. -->
    <PackageReference Include="bouncycastle.cryptography" />
    <PackageReference Include="NSec.Cryptography" Version="$(NSecVersion)" />
    <PackageReference Include="Serilog">
      <Version>4.0.0</Version>
    </PackageReference>
  </ItemGroup>
</Project>
`;

describe(".NET — NuGet", () => {
  it("takes packages.lock.json's resolved pin, never its requested range", () => {
    const packages = parseLockfile("nuget-lock", PACKAGES_LOCK_JSON);
    expect(packages).toContainEqual({ name: "bouncycastle.cryptography", version: "2.4.0" });
    expect(packages).toContainEqual({ name: "nsec.cryptography", version: "24.4.0" });
  });

  it("reads packages.config and skips a commented-out entry", () => {
    const packages = parseLockfile("nuget-packages-config", PACKAGES_CONFIG);
    expect(packages).toContainEqual({ name: "portable.bouncycastle", version: "1.9.0" });
    expect(packages.map((p) => p.name)).not.toContain("nsec.cryptography");
  });

  it("reads PackageReference in both spellings and leaves a centrally-managed version undefined", () => {
    const packages = parseLockfile("dotnet-project", CSPROJ);
    // No Version attribute at all — central package management.
    expect(packages).toContainEqual({ name: "bouncycastle.cryptography", version: undefined });
    // An MSBuild property is not a version.
    expect(packages).toContainEqual({ name: "nsec.cryptography", version: undefined });
    // The child-element spelling.
    expect(packages).toContainEqual({ name: "serilog", version: "4.0.0" });
  });

  it("maps a .NET lockfile to the algorithms its libraries implement", () => {
    const observations = collectDependencyObservations(target([{ path: "packages.lock.json", content: PACKAGES_LOCK_JSON }]));
    expect(names(observations)).toEqual(
      [
        "DSA@acme/widget:pkg:nuget/bouncycastle.cryptography",
        "ECDH/DH@acme/widget:pkg:nuget/bouncycastle.cryptography",
        "ECDH/DH@acme/widget:pkg:nuget/nsec.cryptography",
        "ECDSA@acme/widget:pkg:nuget/bouncycastle.cryptography",
        "EdDSA@acme/widget:pkg:nuget/bouncycastle.cryptography",
        "EdDSA@acme/widget:pkg:nuget/nsec.cryptography",
        "RSA@acme/widget:pkg:nuget/bouncycastle.cryptography",
      ].sort(),
    );
    // Serilog is in the file and is not a crypto library.
    expect(observations.every((o) => !o.location.includes("serilog"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Rust
 * ------------------------------------------------------------------ */

const CARGO_LOCK = `# This file is automatically @generated by Cargo.
# It is not intended for manual editing.
version = 3

[[package]]
name = "ed25519-dalek"
version = "2.1.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "4a3daa8e81a3963a60642bcc1f90a670680bd4a77535faa384e9d1c79d620871"
dependencies = [
 "curve25519-dalek",
 "ed25519",
]

[[package]]
name = "k256"
version = "0.13.3"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "rsa"
version = "0.9.6"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "serde"
version = "1.0.204"
source = "registry+https://github.com/rust-lang/crates.io-index"

[metadata]
"checksum something" = "0000"
`;

describe("Rust — Cargo.lock", () => {
  it("reads every [[package]] table's name and version", () => {
    const packages = parseLockfile("cargo-lock", CARGO_LOCK);
    expect(packages).toContainEqual({ name: "ed25519-dalek", version: "2.1.1" });
    expect(packages).toContainEqual({ name: "rsa", version: "0.9.6" });
    expect(packages).toContainEqual({ name: "serde", version: "1.0.204" });
  });

  it("does not read a [[package]] block's dependencies array as packages", () => {
    // `dependencies = [ "curve25519-dalek", "ed25519" ]` names crates that have
    // their own [[package]] table; reading them here would invent versionless
    // duplicates of rows that already exist.
    const packages = parseLockfile("cargo-lock", CARGO_LOCK);
    expect(packages.map((p) => p.name)).not.toContain("curve25519-dalek");
    expect(packages).toHaveLength(4);
  });

  it("stops reading at the [metadata] table", () => {
    expect(parseLockfile("cargo-lock", CARGO_LOCK).map((p) => p.name)).not.toContain("checksum something");
  });

  it("maps a Cargo.lock to the algorithms its crates implement", () => {
    const observations = collectDependencyObservations(target([{ path: "Cargo.lock", content: CARGO_LOCK }]));
    expect(names(observations)).toEqual(
      [
        "ECDH/DH@acme/widget:pkg:cargo/k256",
        "ECDSA@acme/widget:pkg:cargo/k256",
        "EdDSA@acme/widget:pkg:cargo/ed25519-dalek",
        "RSA@acme/widget:pkg:cargo/rsa",
      ].sort(),
    );
    expect(observations.every((o) => !o.location.includes("serde"))).toBe(true);
  });

  it("scores a single-purpose crate above a general-purpose one", () => {
    const observations = collectDependencyObservations(target([{ path: "Cargo.lock", content: CARGO_LOCK }]));
    expect(observations.find((o) => o.location.endsWith("/rsa"))?.confidence).toBe(0.8);
    // k256 offers ECDSA, BIP340 Schnorr and ECDH; a lockfile cannot say which is called.
    expect(observations.find((o) => o.location.endsWith("/k256"))?.confidence).toBe(0.5);
  });

  it("matches a crate whose lockfile spelling uses underscores", () => {
    const underscored = `[[package]]\nname = "ed25519_dalek"\nversion = "2.1.1"\n`;
    expect(collectDependencyObservations(target([{ path: "Cargo.lock", content: underscored }]))).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Cross-cutting
 * ------------------------------------------------------------------ */

describe("the four new ecosystems, as a whole", () => {
  it("gives every declared lockfile kind a parser and an ecosystem", () => {
    // Widening the union without widening the switch is a compile error, so
    // this only has to prove the runtime side: every kind parses something
    // rather than throwing.
    for (const kind of LOCKFILE_KINDS) {
      expect(() => parseLockfile(kind, ""), kind).not.toThrow();
    }
  });

  it("detects each new file by basename, anywhere in a tree", () => {
    expect(detectLockfileKind("services/api/pom.xml")).toBe("maven-pom");
    expect(detectLockfileKind("gradle.lockfile")).toBe("gradle-lock");
    expect(detectLockfileKind("buildscript-gradle.lockfile")).toBe("gradle-lock");
    expect(detectLockfileKind("app/build.gradle.kts")).toBe("gradle-build");
    expect(detectLockfileKind("cmd/server/go.mod")).toBe("go-mod");
    expect(detectLockfileKind("go.sum")).toBe("go-sum");
    expect(detectLockfileKind("src/Widget/packages.lock.json")).toBe("nuget-lock");
    expect(detectLockfileKind("src/Widget/packages.config")).toBe("nuget-packages-config");
    expect(detectLockfileKind("src/Widget/Widget.csproj")).toBe("dotnet-project");
    expect(detectLockfileKind("Directory.Packages.props")).toBe("dotnet-project");
    expect(detectLockfileKind("crates/core/Cargo.lock")).toBe("cargo-lock");
    // Cargo.toml is a manifest of ranges, and is deliberately not read.
    expect(detectLockfileKind("Cargo.toml")).toBeUndefined();
    expect(detectLockfileKind("go.work")).toBeUndefined();
  });

  it("reports each ecosystem exactly once for a polyglot repository", () => {
    const polyglot = target([
      { path: "pom.xml", content: POM_XML },
      { path: "gradle.lockfile", content: GRADLE_LOCKFILE },
      { path: "go.mod", content: GO_MOD },
      { path: "packages.lock.json", content: PACKAGES_LOCK_JSON },
      { path: "Cargo.lock", content: CARGO_LOCK },
    ]);
    expect(lockfilesIn(polyglot)).toHaveLength(5);
    expect(ecosystemsIn(polyglot).sort()).toEqual(["cargo", "golang", "maven", "nuget"]);
  });

  it("produces a locationDetail every consumer can parse, for every ecosystem", () => {
    const observations = collectDependencyObservations(
      target([
        { path: "pom.xml", content: POM_XML },
        { path: "go.sum", content: GO_SUM },
        { path: "packages.config", content: PACKAGES_CONFIG },
        { path: "Cargo.lock", content: CARGO_LOCK },
      ]),
    );
    expect(observations.length).toBeGreaterThan(0);
    for (const obs of observations) {
      expect(() => LocationDetailSchema.parse(obs.locationDetail)).not.toThrow();
      expect(obs.discoveryModality).toBe("static_artifact_analysis");
      // Every claim is cited or explicitly marked as not.
      expect(["verified", "needs-check"]).toContain(obs.evidence.curationStatus);
      if (obs.evidence.curationStatus === "needs-check") expect(obs.evidence.needsCheckReason).toBeTruthy();
    }
  });

  it("leaves every ecosystem's location prefix free of LIKE wildcards", () => {
    // `asset-ingest.ts`'s `reobservationPredicate` splices this prefix into a
    // LIKE with no escaping, on the stated ground that neither `%` nor `_` can
    // appear in it. Asserted over the prefix the code actually builds, and
    // over the full ECOSYSTEM_VALUES tuple, so a future ecosystem named
    // `go_modules` fails here rather than silently widening a reconciliation
    // to every asset whose location happens to match one character over.
    for (const ecosystem of ECOSYSTEM_VALUES) {
      expect(dependencyLocationPrefix("project:1:acme/widget", ecosystem), ecosystem).not.toMatch(/[%_]/);
    }
  });

  /**
   * The one failure in this file that produces a *plausible* wrong answer
   * rather than an error: two files in one repository that name the same
   * dependency differently mint two assets, both of which look real, and the
   * inventory silently double-counts.
   */
  it("mints one asset when a pom and a gradle.lockfile name the same dependency", () => {
    const observations = collectDependencyObservations(
      target([
        { path: "pom.xml", content: POM_XML },
        { path: "gradle.lockfile", content: GRADLE_LOCKFILE },
      ]),
    );
    const bouncyCastle = observations.filter((o) => o.location.includes("bcprov-jdk18on") && o.algorithm === "RSA");
    expect(bouncyCastle).toHaveLength(1);
    expect(new Set(bouncyCastle.map(fingerprintOf)).size).toBe(1);
  });

  it("mints one asset when a csproj and a packages.lock.json disagree on a NuGet id's casing", () => {
    const observations = collectDependencyObservations(
      target([
        { path: "src/Widget/Widget.csproj", content: CSPROJ },
        { path: "src/Widget/packages.lock.json", content: PACKAGES_LOCK_JSON },
      ]),
    );
    const bouncyCastle = observations.filter((o) => o.location.toLowerCase().includes("bouncycastle") && o.algorithm === "RSA");
    // Two observations, because the two files disagree on the version — the
    // `.csproj` states none at all under central package management and the
    // lock resolves 2.4.0. Two versions are two facts and both are kept.
    expect(bouncyCastle.map((o) => o.evidence.version).sort()).toEqual(["2.4.0", null]);
    // But **one** asset: `location` carries no version, and the casing was
    // folded at parse, so both observations fingerprint to the same row.
    expect(new Set(bouncyCastle.map((o) => o.location)).size).toBe(1);
    expect(new Set(bouncyCastle.map(fingerprintOf)).size).toBe(1);
    // And no upper-cased twin of it exists anywhere in the output.
    expect(observations.every((o) => !o.location.includes("BouncyCastle"))).toBe(true);
  });

  it("mints one asset when go.mod and go.sum name the same module", () => {
    const observations = collectDependencyObservations(
      target([
        { path: "go.mod", content: GO_MOD },
        { path: "go.sum", content: GO_SUM },
      ]),
    );
    const circl = observations.filter((o) => o.location.includes("circl") && o.algorithm === "EdDSA");
    expect(circl).toHaveLength(1);
  });
});
