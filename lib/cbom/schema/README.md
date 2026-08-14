# Vendored CycloneDX schemas

These four files are copied **verbatim** from the official CycloneDX specification repository.
They are the acceptance bar for A5 (see [docs/Claude/03-features.md](../../../docs/Claude/03-features.md)
§A5): the export is only correct if it validates against these, not against a hand-written subset.

| File | Purpose |
|---|---|
| `bom-1.7.schema.json` | The BOM document schema. Also defines `cryptoProperties`. |
| `cryptography-defs.schema.json` | `algorithmFamiliesEnum` / `ellipticCurvesEnum`, referenced from `bom-1.7`. New in 1.7 — in 1.6 these lived inline. |
| `jsf-0.82.schema.json` | JSON Signature Format, referenced by `signature`. Unused by the exporter, required to resolve `$ref`s. |
| `spdx.schema.json` | SPDX licence expressions, referenced by `licenses`. Same. |

## Provenance

- **Source:** <https://github.com/CycloneDX/specification>, `schema/` directory
- **Tag:** `1.7.1` (published 2026-06-02) — a patch release of the tooling/repo; the schema
  itself is unchanged spec version **1.7**, `$id: http://cyclonedx.org/schema/bom-1.7.schema.json`
- **Retrieved:** 2026-08-13. Byte-identical between `master` and tag `1.7.1` at that date
  (checked file by file), so the pin loses nothing.
- **Last upstream change to `bom-1.7.schema.json`:** `0bd48c88` (2026-02-25)

### The version was verified, not assumed

CycloneDX **1.7** was released **2025-10-21** — confirmed against the specification repository's
release list, which is also what [09-open-gaps.md](../../../docs/Claude/09-open-gaps.md) records
as a corrected error in this project's own data (an earlier draft said 1.6). 1.7.1 is a later
*repository* release, not a later spec version: `specVersion` stays `"1.7"`.

**`bom-1.7.schema.json` does not constrain `specVersion`** — it carries `examples: ["1.7"]`, no
`enum` and no `const`. Schema validation therefore cannot prove the document claims 1.7, so
`src/build-cbom.test.ts` asserts `specVersion === "1.7"` and the vendored `$id` separately. Do not
remove those assertions on the grounds that "the schema validates".

## Updating

Re-download all four from the same tag, run `pnpm --filter @workspace/cbom test`, and update the
table above. Never hand-edit these files: a locally patched schema silently lowers the bar the
test exists to enforce.
