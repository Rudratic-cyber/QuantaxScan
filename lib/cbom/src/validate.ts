import { readFileSync } from "node:fs";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

/**
 * Validation against the **official** CycloneDX 1.7 JSON schema, vendored
 * verbatim under `schema/` (see `schema/README.md` for provenance).
 *
 * This is the A5 acceptance bar and it lives in the library, not in one test
 * file, so the api-server suite can hold the HTTP response to the same
 * standard as the builder's unit tests rather than spot-checking fields.
 *
 * **Test-only.** `ajv` is a devDependency and the schema is 400 KB across four
 * files; nothing in `src/build-cbom.ts` imports this module, so the api-server
 * bundle never sees either. Read with `readFileSync` rather than
 * `import … with { type: "json" }` for the same reason — an import would make
 * the schema a static dependency of anything that touches this package.
 */

const SCHEMA_FILES = [
  // The referenced sub-schemas must be registered before the document schema
  // that $refs them; ajv resolves the relative refs against each file's $id.
  "spdx.schema.json",
  "jsf-0.82.schema.json",
  "cryptography-defs.schema.json",
  "bom-1.7.schema.json",
] as const;

const BOM_SCHEMA_ID = "http://cyclonedx.org/schema/bom-1.7.schema.json";

function loadSchema(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../schema/${file}`, import.meta.url), "utf8"));
}

/** The `$id` of the vendored document schema. Asserted by the tests — a swapped-in 1.6 file must not pass unnoticed. */
export function vendoredBomSchemaId(): unknown {
  return loadSchema("bom-1.7.schema.json").$id;
}

export interface CbomValidator {
  /** Type predicate so a caller can narrow; `errors` holds the reasons on failure. */
  (document: unknown): boolean;
  errors: ValidateFunction["errors"];
  /** Human-readable ajv errors, for a test failure message worth reading. */
  explain(): string;
}

export function createCbomValidator(): CbomValidator {
  // draft-07, which is what every CycloneDX schema declares. `strict: false`
  // only relaxes ajv's meta-linting: the CycloneDX files carry `meta:enum` and
  // `deprecated` annotations that ajv does not recognise and would otherwise
  // refuse to compile. It does not weaken any assertion the schema makes.
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
  // CycloneDX uses `date-time`, `iri-reference` and `idn-email`; without this
  // ajv would silently ignore every `format` keyword.
  addFormats(ajv);

  for (const file of SCHEMA_FILES) ajv.addSchema(loadSchema(file));

  const validate = ajv.getSchema(BOM_SCHEMA_ID);
  if (!validate) throw new Error(`vendored schema ${BOM_SCHEMA_ID} did not register`);

  const wrapped = ((document: unknown) => {
    const ok = validate(document);
    wrapped.errors = validate.errors;
    return ok;
  }) as CbomValidator;
  wrapped.errors = null;
  wrapped.explain = () => (wrapped.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("\n");
  return wrapped;
}
