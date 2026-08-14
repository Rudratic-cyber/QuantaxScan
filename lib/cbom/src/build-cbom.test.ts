import { describe, it, expect, beforeAll } from "vitest";
import { buildCbom, cryptoBomRef, KEY_SIZE_UNDETERMINED, PROP_KEY_SIZE, SURFACE_ASSET_TYPE } from "./build-cbom";
import { createCbomValidator, vendoredBomSchemaId, type CbomValidator } from "./validate";
import { CBOM_SPEC_VERSION, type CbomInput, type CycloneDxBom, type CycloneDxComponent } from "./types";

/**
 * A5's acceptance criterion is "output validates against the official
 * CycloneDX 1.7 JSON schema" — so the assertion that matters is `valid(doc)`
 * against the vendored official file, not a list of expected fields.
 *
 * A validator that never rejects anything would satisfy that vacuously, which
 * is the same failure mode lib/db's tenant-isolation suite guards against with
 * its negative control. This file carries the equivalent: a block of
 * deliberately malformed documents that must be *rejected*. If those start
 * passing, every other assertion here is meaningless.
 */

let valid: CbomValidator;
beforeAll(() => {
  valid = createCbomValidator();
});

/** Fails with the schema's own reasons rather than `expected false to be true`. */
function expectValid(doc: unknown): void {
  const ok = valid(doc);
  expect(ok, `CycloneDX 1.7 schema validation failed:\n${valid.explain()}`).toBe(true);
}

const OPTIONS = {
  serialNumber: "urn:uuid:2f9b3c1e-4d5a-4c7b-9e2f-0a1b2c3d4e5f",
  timestamp: new Date("2026-08-13T09:00:00.000Z"),
  toolVersion: "0.0.0",
};

/** One asset per surface, both key-size states, and the full detector vocabulary. */
const FIXTURE: CbomInput = {
  softwareComponents: [
    { bomRef: "project:1", name: "payments-api", version: "1.4.0" },
    { bomRef: "project:2", name: "legacy-batch" },
  ],
  cryptoAssets: [
    {
      fingerprint: "a1b2c3",
      surface: "source",
      algorithm: "RSA",
      keySize: 2048,
      location: "project:1:src/keys.py",
      status: "active",
      firstSeen: new Date("2026-08-01T00:00:00.000Z"),
      lastSeen: new Date("2026-08-13T00:00:00.000Z"),
      containedIn: "project:1",
    },
    // The G-05 case: the collector looked and could not determine the size.
    {
      fingerprint: "d4e5f6",
      surface: "source",
      algorithm: "RSA",
      keySize: null,
      location: "project:1:src/rotate.py",
      status: "active",
      containedIn: "project:1",
    },
    {
      fingerprint: "0a0b0c",
      surface: "source",
      algorithm: "ECDSA",
      keySize: 256,
      location: "project:2:cmd/sign.go",
      status: "remediated",
      containedIn: "project:2",
    },
    { fingerprint: "111", surface: "source", algorithm: "ECDH/DH", keySize: null, location: "project:2:x.go", status: "active", containedIn: "project:2" },
    { fingerprint: "222", surface: "source", algorithm: "DSA", keySize: 1024, location: "project:2:y.go", status: "gone", containedIn: "project:2" },
    { fingerprint: "333", surface: "source", algorithm: "MD5", keySize: null, location: "project:2:z.go", status: "waived", containedIn: "project:2" },
    { fingerprint: "444", surface: "source", algorithm: "SHA-1", keySize: null, location: "project:2:w.go", status: "active", containedIn: "project:2" },
    { fingerprint: "555", surface: "source", algorithm: "AES-ECB", keySize: 128, location: "project:2:v.go", status: "active", containedIn: "project:2" },
    // Surfaces with no collector yet — mapped so the model is tested against
    // the standard now rather than after five more collectors exist.
    { fingerprint: "666", surface: "certificate", algorithm: "RSA", keySize: 4096, location: "0A:1B:2C", status: "active" },
    { fingerprint: "777", surface: "kms", algorithm: "AES-ECB", keySize: 256, location: "arn:aws:kms:eu-west-2:1:key/abc", status: "active" },
    { fingerprint: "888", surface: "kms", algorithm: "RSA", keySize: null, location: "arn:aws:kms:eu-west-2:1:key/def", status: "active" },
    { fingerprint: "999", surface: "tls", algorithm: "ECDH/DH", keySize: null, location: "api.example.com:443", status: "active" },
    { fingerprint: "aaa", surface: "dependency", algorithm: "RSA", keySize: null, location: "npm:node-forge", status: "active" },
    { fingerprint: "bbb", surface: "config", algorithm: "SHA-1", keySize: null, location: "etc/ssh/sshd_config", status: "active" },
    { fingerprint: "ccc", surface: "ot", algorithm: "MD5", keySize: null, location: "plc-3:modbus", status: "active" },
    { fingerprint: "ddd", surface: "binary", algorithm: "AES-ECB", keySize: 128, location: "bin/agent", status: "active" },
  ],
};

function componentFor(doc: CycloneDxBom, fingerprint: string): CycloneDxComponent {
  const ref = cryptoBomRef(fingerprint);
  const found = doc.components.find((c) => c["bom-ref"] === ref);
  if (!found) throw new Error(`no component ${ref}`);
  return found;
}

function propertyValue(component: CycloneDxComponent, name: string): string | undefined {
  return component.properties?.find((p) => p.name === name)?.value;
}

// ───────────────────────────────────────────────────────────────────────────

describe("the vendored schema is the 1.7 one", () => {
  /**
   * `bom-1.7.schema.json` constrains `specVersion` with `examples: ["1.7"]` —
   * no `enum`, no `const`. Schema validation therefore cannot catch a document
   * that claims 1.6, and it cannot catch a 1.6 schema file being dropped in
   * under a 1.7 filename either. Both are checked here instead. This is the
   * "verify rather than assume" half of A5: the register records that an
   * earlier version number in this project's data was simply wrong.
   */
  it("declares $id bom-1.7 — a swapped-in 1.6 file fails here, not silently", () => {
    expect(vendoredBomSchemaId()).toBe("http://cyclonedx.org/schema/bom-1.7.schema.json");
  });

  it("the exporter emits specVersion 1.7, which the schema itself does not enforce", () => {
    expect(CBOM_SPEC_VERSION).toBe("1.7");
    expect(buildCbom(FIXTURE, OPTIONS).specVersion).toBe("1.7");
  });
});

describe("output validates against the official CycloneDX 1.7 JSON schema", () => {
  it("a full inventory — every surface, every detector algorithm, both key-size states", () => {
    expectValid(buildCbom(FIXTURE, OPTIONS));
  });

  it("an empty inventory still produces a valid document", () => {
    expectValid(buildCbom({ softwareComponents: [], cryptoAssets: [] }, OPTIONS));
  });

  it("no serial number and no tool version — both optional, both omitted cleanly", () => {
    expectValid(buildCbom(FIXTURE, { timestamp: OPTIONS.timestamp }));
  });

  it("an algorithm the profile table does not know still exports, and still validates", () => {
    const doc = buildCbom(
      {
        softwareComponents: [],
        cryptoAssets: [{ fingerprint: "z", surface: "source", algorithm: "Kyber-ish", keySize: null, location: "a:b", status: "active" }],
      },
      OPTIONS,
    );
    expectValid(doc);
    // Losing an asset from an inventory is worse than under-describing it.
    expect(doc.components).toHaveLength(1);
    expect(doc.components[0].cryptoProperties?.algorithmProperties?.algorithmFamily).toBeUndefined();
  });

  describe("negative control — the validator really does reject", () => {
    it("rejects an unknown assetType", () => {
      const doc = buildCbom(FIXTURE, OPTIONS) as unknown as CycloneDxBom;
      (doc.components.find((c) => c.cryptoProperties)!.cryptoProperties as { assetType: string }).assetType = "bogus";
      expect(valid(doc)).toBe(false);
    });

    it("rejects a component with no name", () => {
      const doc = buildCbom(FIXTURE, OPTIONS);
      delete (doc.components[0] as { name?: string }).name;
      expect(valid(doc)).toBe(false);
    });

    it("rejects an algorithmFamily outside cryptography-defs.schema.json's enum", () => {
      // 1.7 closed this enum. Proves the *referenced* sub-schema is resolving:
      // if it were not registered, ajv would either throw or skip the $ref.
      const doc = buildCbom(FIXTURE, OPTIONS);
      componentFor(doc, "222").cryptoProperties!.algorithmProperties!.algorithmFamily = "TotallyRealAlgo";
      expect(valid(doc)).toBe(false);
    });

    it("rejects a malformed serialNumber", () => {
      expect(valid(buildCbom(FIXTURE, { ...OPTIONS, serialNumber: "not-a-urn" }))).toBe(false);
    });

    it("rejects a non-CycloneDX document outright", () => {
      expect(valid({ hello: "world" })).toBe(false);
    });
  });
});

describe("keySize: null is carried, never defaulted (G-05)", () => {
  it("a determined size becomes parameterSetIdentifier on an algorithm asset", () => {
    const c = componentFor(buildCbom(FIXTURE, OPTIONS), "a1b2c3");
    expect(c.cryptoProperties?.algorithmProperties?.parameterSetIdentifier).toBe("2048");
    expect(propertyValue(c, PROP_KEY_SIZE)).toBe("2048");
    expect(c.name).toBe("RSA-2048");
  });

  it("an undetermined size emits NO numeric field anywhere in the component", () => {
    const c = componentFor(buildCbom(FIXTURE, OPTIONS), "d4e5f6");
    expect(c.cryptoProperties?.algorithmProperties?.parameterSetIdentifier).toBeUndefined();
    expect(c.cryptoProperties?.relatedCryptoMaterialProperties?.size).toBeUndefined();
    // The name must not imply a size either.
    expect(c.name).toBe("RSA");
    // And nothing anywhere in the serialised component may have invented one.
    expect(JSON.stringify(c)).not.toMatch(/2048|1024|4096|"size"/);
  });

  it("an undetermined size is stated explicitly, not merely absent", () => {
    // A consumer must be able to tell "we looked and do not know" from "this
    // exporter never considered key size". A missing optional field cannot.
    const c = componentFor(buildCbom(FIXTURE, OPTIONS), "d4e5f6");
    expect(propertyValue(c, PROP_KEY_SIZE)).toBe(KEY_SIZE_UNDETERMINED);
  });

  it("every crypto component carries the key-size property, in both states", () => {
    const doc = buildCbom(FIXTURE, OPTIONS);
    const crypto = doc.components.filter((c) => c.type === "cryptographic-asset");
    expect(crypto).toHaveLength(FIXTURE.cryptoAssets.length);
    for (const c of crypto) expect(propertyValue(c, PROP_KEY_SIZE)).toBeDefined();
  });

  it("key material uses relatedCryptoMaterialProperties.size, and omits it when undetermined", () => {
    const doc = buildCbom(FIXTURE, OPTIONS);
    expect(componentFor(doc, "777").cryptoProperties?.relatedCryptoMaterialProperties?.size).toBe(256);
    expect(componentFor(doc, "888").cryptoProperties?.relatedCryptoMaterialProperties?.size).toBeUndefined();
    expect(propertyValue(componentFor(doc, "888"), PROP_KEY_SIZE)).toBe(KEY_SIZE_UNDETERMINED);
  });

  it("no security strength is derived from a key size — that is A4's call, not the exporter's", () => {
    const serialised = JSON.stringify(buildCbom(FIXTURE, OPTIONS));
    expect(serialised).not.toContain("classicalSecurityLevel");
    expect(serialised).not.toContain("nistQuantumSecurityLevel");
  });
});

describe("algorithms, keys and certificates, and their relationship to software components", () => {
  it("each surface maps to the documented CycloneDX assetType", () => {
    const doc = buildCbom(FIXTURE, OPTIONS);
    for (const asset of FIXTURE.cryptoAssets) {
      expect(componentFor(doc, asset.fingerprint).cryptoProperties?.assetType).toBe(SURFACE_ASSET_TYPE[asset.surface]);
    }
  });

  it("a software component dependsOn exactly the crypto found inside it", () => {
    const doc = buildCbom(FIXTURE, OPTIONS);
    const edge = doc.dependencies.find((d) => d.ref === "project:1");
    expect(edge?.dependsOn).toEqual([cryptoBomRef("a1b2c3"), cryptoBomRef("d4e5f6")].sort());
  });

  it("every dependency reference resolves to a component in the same document", () => {
    // JSON Schema cannot check this: refLinkType is just a string, so a
    // dangling bom-ref validates happily and breaks every consumer that walks
    // the graph.
    const doc = buildCbom(FIXTURE, OPTIONS);
    const refs = new Set(doc.components.map((c) => c["bom-ref"]));
    for (const dep of doc.dependencies) {
      expect(refs, `dependencies[].ref ${dep.ref}`).toContain(dep.ref);
      for (const target of dep.dependsOn ?? []) expect(refs, `dependsOn ${target}`).toContain(target);
    }
  });

  it("an asset naming a software component that is not exported gets no edge, not a dangling ref", () => {
    const doc = buildCbom(
      {
        softwareComponents: [],
        cryptoAssets: [{ ...FIXTURE.cryptoAssets[0], containedIn: "project:404" }],
      },
      OPTIONS,
    );
    expectValid(doc);
    expect(doc.dependencies.every((d) => (d.dependsOn ?? []).length === 0)).toBe(true);
    expect(JSON.stringify(doc)).not.toContain("project:404");
  });

  it("bom-refs are unique across the document", () => {
    const doc = buildCbom(FIXTURE, OPTIONS);
    const refs = doc.components.map((c) => c["bom-ref"]);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("the asset's stable locator is exported as evidence, so a finding is traceable back", () => {
    expect(componentFor(buildCbom(FIXTURE, OPTIONS), "a1b2c3").evidence?.occurrences).toEqual([
      { location: "project:1:src/keys.py" },
    ]);
  });
});

describe("the export is deterministic", () => {
  it("same input and options produce byte-identical output", () => {
    expect(JSON.stringify(buildCbom(FIXTURE, OPTIONS))).toBe(JSON.stringify(buildCbom(FIXTURE, OPTIONS)));
  });

  it("input order does not change the output — two exports of an unchanged inventory diff clean", () => {
    const shuffled: CbomInput = {
      softwareComponents: [...FIXTURE.softwareComponents].reverse(),
      cryptoAssets: [...FIXTURE.cryptoAssets].reverse(),
    };
    expect(JSON.stringify(buildCbom(shuffled, OPTIONS))).toBe(JSON.stringify(buildCbom(FIXTURE, OPTIONS)));
  });
});
