import { describe, expect, it } from "vitest";
import { collectRetrievedAt, findStale } from "./check-standards-freshness";

const NOW = new Date("2026-08-14T00:00:00Z");

describe("collectRetrievedAt — finds every dated entry wherever it is nested", () => {
  it("reports the path so a human can find the entry without grepping", () => {
    const found = collectRetrievedAt({
      algorithms: [{ id: "rsa", citation: { retrievedAt: "2026-08-01" } }],
    });
    expect(found).toEqual([{ location: "$.algorithms[0].citation", retrievedAt: "2026-08-01" }]);
  });

  it("finds dates at several depths in one pass", () => {
    const found = collectRetrievedAt({
      retrievedAt: "2026-01-01",
      a: { b: { c: { retrievedAt: "2026-02-02" } } },
      list: [{ retrievedAt: "2026-03-03" }, { nothing: true }],
    });
    expect(found.map((f) => f.retrievedAt).sort()).toEqual(["2026-01-01", "2026-02-02", "2026-03-03"]);
  });

  it("ignores a non-string retrievedAt rather than crashing on hostile data", () => {
    expect(collectRetrievedAt({ retrievedAt: 20260801 })).toEqual([]);
  });
});

describe("findStale — the G-14 trigger", () => {
  const file = (json: unknown) => [{ file: "algorithms.json", json }];

  it("passes an entry inside the window", () => {
    expect(findStale(file({ retrievedAt: "2026-08-01" }), NOW, 180)).toEqual([]);
  });

  it("fails an entry past the window, and reports its age", () => {
    const stale = findStale(file({ retrievedAt: "2025-01-01" }), NOW, 180);
    expect(stale).toHaveLength(1);
    expect(stale[0].ageDays).toBe(590);
  });

  it("treats the boundary as inclusive — exactly at the limit is still fresh", () => {
    // 180 days before 2026-08-14 is 2026-02-15. Off-by-one here would fire the alarm a day
    // early every time, which is how a check gets muted.
    expect(findStale(file({ retrievedAt: "2026-02-15" }), NOW, 180)).toEqual([]);
    expect(findStale(file({ retrievedAt: "2026-02-14" }), NOW, 180)).toHaveLength(1);
  });

  it("flags an unparseable date, which would otherwise never expire", () => {
    const stale = findStale(file({ retrievedAt: "not a date" }), NOW, 180);
    expect(stale).toHaveLength(1);
    expect(stale[0].ageDays).toBe(Number.POSITIVE_INFINITY);
  });

  it("sorts oldest first, so the worst offender is the first thing read", () => {
    const stale = findStale(
      file({ a: { retrievedAt: "2025-06-01" }, b: { retrievedAt: "2024-01-01" } }),
      NOW,
      180,
    );
    expect(stale.map((s) => s.retrievedAt)).toEqual(["2024-01-01", "2025-06-01"]);
  });
});

describe("the committed mappings data", () => {
  it("has no entry more than a year old — a floor, not the real window", () => {
    // The real gate is `pnpm run check:standards` at 180 days, run in CI. This asserts a much
    // looser bound so the suite does not start failing on a calendar date with no code change,
    // which would train everyone to ignore it.
    const files = ["algorithms.json", "frameworks.json", "controls.json"].map((name) => ({
      file: name,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      json: JSON.parse(
        require("node:fs").readFileSync(
          require("node:path").resolve(__dirname, "..", "..", "docs", "Claude", "mappings", name),
          "utf8",
        ),
      ) as unknown,
    }));
    expect(findStale(files, NOW, 365)).toEqual([]);
  });
});
