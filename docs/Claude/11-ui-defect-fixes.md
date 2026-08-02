# 11 — UI defect fixes

Record of the frontend defects closed after the visual review of `main` at `2c0e5bd`
(*Merge UI redesign + Replit fixes onto renamed main*, #4). Written 2026-08-03.

The review's own verdict on the redesign — theme, typography, spacing, Coverage, Security,
Report, 404 — was that it is good work needing nothing, and none of it was touched. What follows
is only the defects. Every item was verified in a rendered browser at `1440`; item 1, which
reproduced at every width tested, was additionally checked at `1280` and `1920`.

**Deliberately not addressed here**, because both are captain decisions rather than bugs: the
browser-auth story (the bundle holds no API key until per-user accounts land, so Upload Code,
GitHub URL, Create Post and share-Report all dead-end on 401) and the Community mock feed. This
work makes those failures *honest*; it does not make them succeed.

---

## Functional

### 1. Demo findings panel clipped at every viewport width

**Was:** ~42% of every finding card on `/demo/:slug` was cut off with no horizontal scrollbar,
slicing the NIST replacement rationale mid-sentence — on the one journey that works end to end.

**Cause:** Radix's `ScrollArea` gives its viewport's content wrapper an inline `display: table`
(`@radix-ui/react-scroll-area` `Viewport`). `table` shrink-wraps to max-content, so the cards laid
out at 493px inside a 288px (`w-72`) panel and the overflow was clipped — this component renders
only a vertical `ScrollBar`, so there was nothing to scroll horizontally with. Not a narrow-
viewport problem: it reproduced at 1920 too.

**Changed:** `components/ui/scroll-area.tsx` gained an optional `viewportClassName` prop, and the
Demo findings rail passes `[&>div]:block!` to force the content to the viewport's width.
Scoped to that one panel rather than applied globally, so no other `ScrollArea` changes behaviour.
Measured after: viewport 287px, card 263px, `scrollWidth === clientWidth`, explanation text wraps,
and the last finding plus the Executive Summary block remain reachable.

### 2. GitHub fetch reported the wrong cause

**Was:** a 401 from `POST /api/github/fetch` surfaced as *"Fetch failed — check the URL and try
again."* — actively misdirecting, since the URL is fine and no amount of retyping helps.

**Cause:** both error strings on the Scan page keyed off `githubPhase === "error"` alone, with no
record of *why* it failed.

**Changed:** `Scan.tsx` carries a `githubError` `{ long, short }` alongside the phase, set from
the HTTP status (not from message text) in both `fetchRepo` and `runGithubScan` and cleared when
either starts. 401/403 now reads *"Not authorised — the scanner API rejected this request. The URL
is fine…"*; 400/404 keeps the check-the-URL wording, which is correct there; the GitHub rate-limit
branch gets its own message, closing the review's other note that the centre pane said "check URL"
while the left rail correctly explained the rate limit. The copy deliberately does **not** tell
the user to add an API key — they have no way to do that from the browser, which would be a second
misdirection wearing the first one's clothes.

### 3. Uploads contaminated by shipped scaffolding

**Was:** uploading one file produced *"2 files scanned, 13 findings"* — the built-in
`SecurityManager.java` demo project was never cleared, so its six findings merged into the user's
results and inflated the headline risk and effort numbers.

**Cause:** `handleZipFile` replaced the tab set, but the single-file path went through
`openFileInTab`, which *appended*. The sample tab survived and was scanned as user code.

**Changed:** `Tab` gained a `sample` flag, set on the shipped demo files; opening a user file
drops every sample tab. Tab ids now come from a monotonic ref rather than `Date.now()`, which
collides when several files are opened in one loop. Adjacent trap found and fixed in the same
pass: `handleLanguageChange` reset the tab set to the language's sample unconditionally, so
changing language *after* an upload silently discarded the user's file — it is now gated on
`!hasCustomFile`.

### 4. Dashboard empty state misreported, and its tabs were wrongly gated

**Was:** an authentication failure rendered as *"No scans yet"*, which is a different claim
entirely — and it sent the user to a scanner that also cannot work, a loop with no exit.
Separately, all three tabs short-circuited on `projects.length`, so Community Intel showed
"No scans yet" even though its data is public and needs no key.

**Changed:** `Dashboard.tsx` now distinguishes three states — loading, request refused, genuinely
empty — in both the header subtitle and the empty card, and the refused state offers *Try again*
rather than *Run a scan*. The `sorted.length === 0` short-circuit moved inside the Overview
branch. AI Analysis renders its own null-safe "Select a project" state; Community Intel renders
its public feed (empty today, because the real API returns `[]` — which is the correct outcome,
not a reason to touch the mock content).

### 5. Report page had no error boundary

**Was:** a stored payload in a legacy or foreign shape (e.g. carrying `files` where
`Report.tsx` reads `fileResults`) threw during render and white-screened the page. Not reachable
through the UI today — but `/report/:id` is a *public, shareable* URL, so the blank page is what
the customer's recipient sees.

**Changed:** new `components/ErrorBoundary.tsx`, wrapping the `/report/:id` route in `App.tsx`.
The fallback matches the page's existing "Report not found" panel and offers the same escape.
Verified by storing a deliberately legacy-shaped payload and loading its share URL.

### 6. README page list stale

`README.md` still listed the pages as they were before merge #3. `Coverage` and `Security` added.

## Cosmetic

7. **Low-contrast captions.** Security's two `#9aa3b2` captions and the footer's `PLANNED` badges
   moved to `#6b7280` (≈4.8:1 on white, versus ≈2.8:1 before); the badge also gained a border.
   Scoped to the three places the review named — other `#9aa3b2` greys are intentional and stay.
8. **Security commitments read as a to-do list.** The ten `☐` glyphs became indigo list markers in
   the same 20px footprint. A tick was rejected: it would claim the commitments are already met,
   which contradicts the honesty positioning the page is built on.
9. **Report header logo.** Swapped the lone `Shield` glyph for the hexagon mark and `QuantaXscan`
   wordmark used everywhere else. `Shield` is still used elsewhere on the page and stays imported.
10. **Create Post error toast overlapped the footer.** The toast viewport was anchored bottom-right
    and landed squarely on the footer links. It now sits below the fixed navbar (`top-14` /
    `md:top-16`) and is `pointer-events-none`, so whatever is underneath stays clickable — the
    toasts themselves already re-enable pointer events.

---

## Gap register

None of these correspond to an open entry in [09-open-gaps.md](09-open-gaps.md); the register
tracks detection quality, standards data and platform gaps, not frontend defects. Item 4 is the
UI-side consequence of the G-12 interim auth landing, and is noted there.

## Verification

Verified against a local stack (`docker` Postgres, `@workspace/api-server`, `@workspace/quantaxscan`
dev server) with a **keyless browser** — the correct environment, since items 2 and 4 need a real
401 to exercise. Frontend `pnpm run typecheck` holds at its documented 13-error pre-existing
baseline; see [CLAUDE.md](../../CLAUDE.md). No non-401 console errors on `/`, `/coverage`,
`/community`, `/dashboard`, `/scan`, `/demo/:slug`, `/report/:id` or the 404 route.
