import { describe, it, expect } from "vitest";
import { SURFACE_VALUES } from "./enums";
import {
  COLLECTOR_SURFACES,
  LIVE_COLLECTOR_SURFACES,
  catalogueEntryForSurface,
  type CollectorSurfaceEntry,
} from "./surface-catalogue";

/**
 * The catalogue is the denominator of D3's honesty claim ("8 of 13 examined"),
 * so these assertions are about the *numbers on the page*, not about tidiness.
 * Each one fails loudly for a specific real change:
 *
 *  - a fourteenth surface added to the roadmap but not to the UI, or vice versa
 *  - a new `Surface` enum value added with no catalogue entry to record it
 *    under, which would let observations land somewhere the meter never counts
 *  - a collector going live without the coverage copy being revisited
 */
describe("collector surface catalogue", () => {
  it("has thirteen surfaces — the number docs/Claude/03-features.md §B and the coverage page both state", () => {
    expect(COLLECTOR_SURFACES).toHaveLength(13);
  });

  it("has unique ids, because presentation and coverage data are joined on them", () => {
    const ids = COLLECTOR_SURFACES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("claims every `Surface` enum value exactly once", () => {
    const claimed = COLLECTOR_SURFACES.map((entry) => entry.surface).filter((s) => s !== null);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual([...SURFACE_VALUES].sort());
  });

  it("records that every catalogued surface is now storable", () => {
    // `data-at-rest` and `vendor` were the last two with no `Surface` value —
    // a deeper gap than "planned", because the database could not have stored
    // a finding from them even if a collector existed. Both enum values landed
    // 2026-08-14, ahead of their collectors, in one migration.
    //
    // This asserts the current state, not a rule: a future surface may well be
    // catalogued before the schema can record it, and `surface: null` is still
    // the honest way to say so. What must not happen is an entry claiming a
    // `Surface` the enum does not have — the test above covers that.
    //
    // Read through `CollectorSurfaceEntry` rather than the `as const` literal
    // type: with every entry's `surface` non-null today, the narrowed literal
    // type makes the filtered array `never[]` and `e.id` a type error, so a
    // test asserting the runtime state would not compile. Widening keeps the
    // assertion about the data, which is the thing that can change.
    const catalogue: readonly CollectorSurfaceEntry[] = COLLECTOR_SURFACES;
    const unrecordable = catalogue.filter((entry) => entry.surface === null).map((e) => e.id);
    expect(unrecordable).toEqual([]);
  });

  it("has exactly nine live collectors, the ninth being network conversations", () => {
    // `dependency` became live when B2's ingest path landed, `tls` when B3's
    // did (`POST /projects/:id/tls`), `certificate` when B4's did
    // (`POST /projects/:id/certificates`), `kms` when B5's did
    // (`POST /projects/:id/kms`), `config` when B6's did
    // (`POST /projects/:id/protocol-config`), `data-at-rest` when B7's did
    // (`POST /projects/:id/data-at-rest`), and `network-flow` when B11's did
    // (`POST /projects/:id/network-flows`). A collector with nowhere to write
    // is not a live surface — the whole point of this list is that it is the
    // denominator of an honesty claim, so an entry earns `live` by being able
    // to record a collection run, not by existing in the repo.
    expect(LIVE_COLLECTOR_SURFACES.map((entry) => entry.id)).toEqual([
      "source",
      "dependency",
      "tls",
      "certificate",
      "kms",
      "config",
      "data-at-rest",
      "ot",
      "network-flow",
    ]);
  });

  it("gives every live surface somewhere to store what it finds", () => {
    for (const entry of LIVE_COLLECTOR_SURFACES) {
      expect(entry.surface, `${entry.id} is live but has no Surface value to record under`).not.toBeNull();
    }
  });

  it("resolves a stored surface back to its catalogue entry", () => {
    expect(catalogueEntryForSurface("source")?.id).toBe("source");
    expect(catalogueEntryForSurface("binary")?.name).toBe("Binaries / firmware");
    for (const value of SURFACE_VALUES) {
      expect(catalogueEntryForSurface(value), `no catalogue entry records "${value}"`).toBeDefined();
    }
  });
});
