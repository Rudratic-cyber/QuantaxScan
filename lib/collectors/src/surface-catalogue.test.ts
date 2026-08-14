import { describe, it, expect } from "vitest";
import { SURFACE_VALUES } from "./enums";
import {
  COLLECTOR_SURFACES,
  LIVE_COLLECTOR_SURFACES,
  catalogueEntryForSurface,
} from "./surface-catalogue";

/**
 * The catalogue is the denominator of D3's honesty claim ("2 of 10 examined"),
 * so these assertions are about the *numbers on the page*, not about tidiness.
 * Each one fails loudly for a specific real change:
 *
 *  - an eleventh surface added to the roadmap but not to the UI, or vice versa
 *  - a ninth `Surface` enum value added with no catalogue entry to record it
 *    under, which would let observations land somewhere the meter never counts
 *  - a collector going live without the coverage copy being revisited
 */
describe("collector surface catalogue", () => {
  it("has ten surfaces — the number docs/Claude/03-features.md §B and the coverage page both state", () => {
    expect(COLLECTOR_SURFACES).toHaveLength(10);
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

  it("records that exactly two surfaces have no `Surface` value at all", () => {
    // Not an oversight to be fixed by inventing enum values: the asset model
    // genuinely cannot store a data-at-rest or vendor finding today, and the
    // meter reports that as a deeper gap than "planned".
    const unrecordable = COLLECTOR_SURFACES.filter((entry) => entry.surface === null).map((e) => e.id);
    expect(unrecordable).toEqual(["data-at-rest", "vendor"]);
  });

  it("has exactly four live collectors: source, dependency, tls and certificate", () => {
    // `dependency` became live when B2's ingest path landed, `tls` when B3's
    // did (`POST /projects/:id/tls`), and `certificate` when B4's did
    // (`POST /projects/:id/certificates`). A collector with nowhere to write
    // is not a live surface — the whole point of this list is that it is the
    // denominator of an honesty claim, so an entry earns `live` by being able
    // to record a collection run, not by existing in the repo.
    expect(LIVE_COLLECTOR_SURFACES.map((entry) => entry.id)).toEqual(["source", "dependency", "tls", "certificate"]);
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
