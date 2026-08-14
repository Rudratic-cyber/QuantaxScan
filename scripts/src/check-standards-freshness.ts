/**
 * G-14 — the re-verification trigger the register says does not exist.
 *
 * Standards data decays and nothing currently prompts a re-check. NIST IR 8547 is a *draft*
 * that will presumably be finalised, at which point every date in the system needs revisiting
 * and the "draft guidance" labels need removing. There is no mechanism that would tell us.
 *
 * This is that mechanism, in its cheapest useful form: fail when any `retrievedAt` in
 * docs/Claude/mappings/ is older than the staleness window, so the prompt arrives as a build
 * failure rather than as a customer noticing a stale date in a report.
 *
 * Deliberately NOT a network check. Fetching each source and diffing it would be a different,
 * much less reliable tool — several primary sources return HTTP 403 to automated fetches
 * (G-01), so a network check would fail for reasons that have nothing to do with staleness and
 * would be muted within a week. A date comparison cannot be wrong about what it measures.
 *
 *   pnpm run check:standards            fail over the window (default 180 days)
 *   pnpm run check:standards --warn     report, exit 0 — for a pre-push hook
 *   STANDARDS_MAX_AGE_DAYS=90 …         tighten the window
 *   STANDARDS_TODAY=2027-01-01 …        pin "now" (tests; also makes CI reproducible)
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mappingsDir = path.resolve(here, "..", "..", "docs", "Claude", "mappings");

const DEFAULT_MAX_AGE_DAYS = 180;
const maxAgeDays = Number(process.env["STANDARDS_MAX_AGE_DAYS"] ?? DEFAULT_MAX_AGE_DAYS);
const warnOnly = process.argv.includes("--warn");

const todayRaw = process.env["STANDARDS_TODAY"];
const today = todayRaw ? new Date(`${todayRaw}T00:00:00Z`) : new Date();
if (Number.isNaN(today.getTime())) {
  throw new Error(`STANDARDS_TODAY is not a date: "${todayRaw}"`);
}

export interface StaleEntry {
  file: string;
  /** Dotted path to the object carrying the date, so a human can find it without grepping. */
  location: string;
  retrievedAt: string;
  ageDays: number;
}

const DAY_MS = 86_400_000;

/** Walks any JSON shape and yields every `retrievedAt` with the path it was found at. */
export function collectRetrievedAt(value: unknown, at = "$"): Array<{ location: string; retrievedAt: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => collectRetrievedAt(item, `${at}[${i}]`));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const found: Array<{ location: string; retrievedAt: string }> = [];
    if (typeof record["retrievedAt"] === "string") {
      found.push({ location: at, retrievedAt: record["retrievedAt"] });
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== "retrievedAt") found.push(...collectRetrievedAt(child, `${at}.${key}`));
    }
    return found;
  }
  return [];
}

export function findStale(
  files: Array<{ file: string; json: unknown }>,
  now: Date,
  maxAge: number,
): StaleEntry[] {
  const stale: StaleEntry[] = [];
  for (const { file, json } of files) {
    for (const { location, retrievedAt } of collectRetrievedAt(json)) {
      const when = new Date(`${retrievedAt}T00:00:00Z`);
      if (Number.isNaN(when.getTime())) {
        // An unparseable date is worse than an old one: it silently never expires.
        stale.push({ file, location, retrievedAt, ageDays: Number.POSITIVE_INFINITY });
        continue;
      }
      const ageDays = Math.floor((now.getTime() - when.getTime()) / DAY_MS);
      if (ageDays > maxAge) stale.push({ file, location, retrievedAt, ageDays });
    }
  }
  return stale.sort((a, b) => b.ageDays - a.ageDays);
}

function main(): void {
  const files = readdirSync(mappingsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      file: f,
      json: JSON.parse(readFileSync(path.join(mappingsDir, f), "utf8")) as unknown,
    }));

  const total = files.reduce((n, f) => n + collectRetrievedAt(f.json).length, 0);
  const stale = findStale(files, today, maxAgeDays);

  if (stale.length === 0) {
    console.log(
      `✓ standards freshness: ${total} dated ${total === 1 ? "entry" : "entries"} across ` +
        `${files.length} files, none older than ${maxAgeDays} days.`,
    );
    return;
  }

  console.error(
    `${warnOnly ? "⚠" : "✗"} standards freshness: ${stale.length} of ${total} entries are older ` +
      `than ${maxAgeDays} days.\n`,
  );
  for (const entry of stale) {
    const age = Number.isFinite(entry.ageDays) ? `${entry.ageDays}d` : "unparseable date";
    console.error(`  ${entry.file}  ${entry.location}  retrievedAt ${entry.retrievedAt}  (${age})`);
  }
  console.error(
    "\nRe-verify each against its primary source, then update `retrievedAt` — and only after\n" +
      "actually re-reading it. Bumping the date without opening the source is the one failure\n" +
      "mode this check cannot detect, and it would make the register lie.\n" +
      "See docs/Claude/09-open-gaps.md G-14.",
  );

  if (!warnOnly) process.exitCode = 1;
}

// Only run when invoked directly, so the tests can import the pure functions.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
