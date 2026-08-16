import type { BoardPack } from "./board-pack";
import type { RegulatorSubmission } from "./regulator-submission";
import type { Assumption, CoverageLimitations, ReportHeader } from "./report-common";

/**
 * The one renderer. docs/Claude/07-reports.md §Rendering: "HTML source of truth
 * → PDF via headless Chrome … Do not build two renderers." So the `.pdf`
 * endpoints print exactly the markup the `.html` endpoints serve, and a defect
 * visible in one is visible in the other.
 *
 * Deliberately dependency-free and inline-styled. A report is evidence; it has
 * to render identically from a saved file with no network, five years after the
 * CDN it would otherwise have loaded a stylesheet from stopped existing.
 *
 * Everything interpolated goes through `esc()`. The strings here include asset
 * locations and algorithm names, which are attacker-controllable — a source
 * file can be named anything — and this markup is served to a browser and to
 * headless Chrome, so an unescaped one is a stored XSS in a document a board
 * member opens.
 */

const PRINT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 11pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #14181f;
  background: #fff;
}
main { max-width: 190mm; margin: 0 auto; padding: 12mm 10mm 18mm; }
h1 { font-size: 20pt; margin: 0 0 2mm; letter-spacing: -0.01em; }
h2 { font-size: 13pt; margin: 8mm 0 2mm; padding-bottom: 1.5mm; border-bottom: 1px solid #d6dae1; }
h3 { font-size: 11pt; margin: 5mm 0 1.5mm; }
p { margin: 0 0 2.5mm; }
ul { margin: 0 0 3mm; padding-left: 5mm; }
li { margin: 0 0 1mm; }
.subtitle { color: #55606f; margin: 0 0 5mm; font-size: 10pt; }
.headline { font-size: 13pt; line-height: 1.45; margin: 0 0 3mm; }
.meta { width: 100%; border-collapse: collapse; font-size: 9pt; margin: 0 0 5mm; }
.meta th, .meta td { text-align: left; vertical-align: top; padding: 1.2mm 3mm 1.2mm 0; border-bottom: 1px solid #eceef2; }
.meta th { width: 45mm; font-weight: 600; color: #55606f; }
table.data { width: 100%; border-collapse: collapse; font-size: 9pt; margin: 0 0 4mm; }
table.data th, table.data td { text-align: left; padding: 1.5mm 2mm; border-bottom: 1px solid #eceef2; vertical-align: top; }
table.data th { background: #f4f6f9; font-weight: 600; border-bottom: 1px solid #d6dae1; }
table.data td.num { text-align: right; font-variant-numeric: tabular-nums; }
.callout { border-left: 3px solid #b4451f; background: #fdf4f0; padding: 3mm 4mm; margin: 0 0 4mm; }
.callout.neutral { border-left-color: #46536b; background: #f4f6f9; }
.callout h3 { margin-top: 0; }
.assumed { display: inline-block; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em;
  background: #fbecd2; color: #6d4a06; border-radius: 2px; padding: 0.4mm 1.4mm; margin-left: 1.5mm; }
.indicative { display: inline-block; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em;
  background: #e6e9ef; color: #46536b; border-radius: 2px; padding: 0.4mm 1.4mm; margin-left: 1.5mm; }
.small { font-size: 9pt; color: #55606f; }
.mono { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 8.5pt; word-break: break-all; }
.page-break { break-before: page; }
.asset { border: 1px solid #e2e5ea; border-radius: 3px; padding: 3mm 4mm; margin: 0 0 3mm; break-inside: avoid; }
.asset h3 { margin: 0 0 1.5mm; font-size: 10pt; }
footer { margin-top: 8mm; padding-top: 2mm; border-top: 1px solid #d6dae1; font-size: 8.5pt; color: #55606f; }
@page { size: A4; margin: 14mm 0; }
@media print { main { padding-top: 0; } }
`;

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${PRINT_CSS}</style>
</head><body><main>${body}</main></body></html>`;
}

function headerTable(header: ReportHeader): string {
  const rows: Array<[string, string]> = [
    ["Generated", header.generatedAt],
    [
      "Inventory as of",
      header.inventoryAsOf ??
        "No asset has been recorded, so this document has no inventory instant. It is not a statement about now.",
    ],
    ["Obligations evaluated at", header.asOf],
    ["Standards data version", `algorithms ${header.mappingDataVersion} · frameworks ${header.frameworksDataVersion}`],
    [
      "Q-Day scenarios",
      header.scenarios.map((s) => `${s.name} ${s.qDayYear} (${s.confidence})`).join(" · "),
    ],
    [
      "Collectors",
      header.collectors.length === 0
        ? "No collection run has been recorded."
        : header.collectors
            .map((c) => `${c.collector}@${c.collectorVersion} (${c.surface}, ${c.completedRuns} run(s))`)
            .join(" · "),
    ],
    [
      "Product version",
      header.productVersion ?? "Not stamped by this build. No version is asserted rather than a placeholder printed.",
    ],
    ["Coverage", header.coverageSummary],
  ];
  return `<table class="meta">${rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("")}</table>
<p class="small">${esc(header.framing)}</p>`;
}

function coverageCallout(coverage: CoverageLimitations | Omit<CoverageLimitations, "unmappedAlgorithms">): string {
  const unexamined =
    coverage.unexaminedSurfaces.length === 0
      ? "<p>Every surface in the collector catalogue has been examined at least once.</p>"
      : `<ul>${coverage.unexaminedSurfaces
          .map((s) => `<li><strong>${esc(s.name)}</strong> — ${esc(s.reason)}</li>`)
          .join("")}</ul>`;
  return `<div class="callout"><h3>Coverage — read this before any number below</h3>
<p>${esc(coverage.statement)}</p>
${unexamined}
<p class="small">${esc(coverage.estateFractionReason)}</p>
${coverage.caveats.length === 0 ? "" : `<ul class="small">${coverage.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`}
</div>`;
}

function assumptionsTable(assumptions: Assumption[]): string {
  return `<table class="data"><thead><tr><th>Assumption</th><th>Value</th><th>Basis</th></tr></thead><tbody>${assumptions
    .map(
      (a) =>
        `<tr><td>${esc(a.label)}${a.assumed ? '<span class="assumed">assumed</span>' : ""}</td>` +
        `<td>${esc(a.value)}</td><td class="small">${esc(a.basis)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

// ── E1 ───────────────────────────────────────────────────────────────────────

export function renderBoardPackHtml(pack: BoardPack): string {
  const { exposure, timing, cost, trend, coverage } = pack.page1;

  const scenarioRows = timing.scenarios
    .map(
      (s) =>
        `<tr><td>${esc(s.scenario)}</td><td class="num">${esc(s.qDayYear)}</td>` +
        `<td class="num">${esc(s.assetsBreached)}</td>` +
        `<td class="num">${s.worstOvershootYears === null ? "—" : esc(s.worstOvershootYears)}</td>` +
        `<td class="small">${esc(s.confidence)}${s.confidence !== "verified" ? '<span class="indicative">indicative</span>' : ""}</td></tr>`,
    )
    .join("");

  // Page one is the four questions plus the coverage gap, and nothing else —
  // doc 07 budgets it at one page for a reader with four minutes. The
  // assumption register is the one thing that would push it over, so it rides
  // in the limitations appendix, next to the other reasons a number is not what
  // it looks like.
  const appendices = pack.appendices
    .map(
      (appendix) => `<section class="page-break"><h2>${esc(appendix.title)}</h2>
<p class="small">${esc(appendix.summary)}</p>
${
  appendix.rows.length === 0
    ? "<p class=\"small\">Nothing to list.</p>"
    : `<table class="data"><thead><tr>${appendix.columns
        .map((c) => `<th>${esc(c.label)}</th>`)
        .join("")}</tr></thead><tbody>${appendix.rows
        .map(
          (row) =>
            `<tr>${appendix.columns
              .map((c) => {
                const value = row[c.key];
                const numeric = typeof value === "number";
                return `<td${numeric ? ' class="num"' : ""}>${value === null ? "—" : esc(value)}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("")}</tbody></table>`
}
${appendix.notes.length === 0 ? "" : `<ul class="small">${appendix.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`}
${
  appendix.id === "c-limits"
    ? `<h3>Assumptions behind every number in this pack</h3>${assumptionsTable(pack.assumptions)}`
    : ""
}
</section>`,
    )
    .join("");

  return page(
    "Post-quantum exposure — board pack",
    `<h1>Post-quantum exposure</h1>
<p class="subtitle">Board and audit-committee pack · one page, three appendices</p>
${headerTable(pack.header)}

<h2>Are we exposed?</h2>
<p class="headline">${esc(exposure.headline)}</p>
<table class="data"><thead><tr><th>Measure</th><th>Count</th></tr></thead><tbody>
<tr><td>Items of cryptography found</td><td class="num">${esc(exposure.assetsFound)}</td></tr>
<tr><td>Of a kind a quantum computer is expected to break</td><td class="num">${esc(exposure.quantumVulnerableAssets)}</td></tr>
<tr><td>Already past the point where replacement is timely</td><td class="num">${esc(exposure.assetsAlreadyTooLate)}</td></tr>
<tr><td>Ordinary cryptographic defects, unrelated to quantum computing</td><td class="num">${esc(exposure.classicalHygieneAssets)}</td></tr>
<tr><td>Not assessable against current standards data</td><td class="num">${esc(exposure.unassessableAssets)}</td></tr>
</tbody></table>

<h2>How badly, and by when?</h2>
<p class="headline">${esc(timing.headline)}</p>
<table class="data"><thead><tr><th>Scenario</th><th>Deadline year</th><th>Items already too late</th><th>Worst overshoot (years)</th><th>Source confidence</th></tr></thead>
<tbody>${scenarioRows}</tbody></table>
<p class="small">${esc(timing.framing)}</p>

<h2>What will it cost?</h2>
<p class="headline">${esc(cost.statement)}</p>
<p class="small">${esc(cost.hourlyRateBasis)}${cost.hourlyRateAssumed ? '<span class="assumed">assumed</span>' : ""}</p>
<table class="data"><thead><tr><th>Basis</th><th>Count</th></tr></thead><tbody>
<tr><td>Items with an effort estimate recorded against the item itself</td><td class="num">${esc(cost.assetsWithRecordedEffort)}</td></tr>
<tr><td>Items taking the per-algorithm average from the standards data</td><td class="num">${esc(cost.assetsWithDerivedEffort)}</td></tr>
<tr><td>Items with no effort estimate, excluded from the total</td><td class="num">${esc(cost.assetsWithoutEffortEstimate)}</td></tr>
</tbody></table>

<h2>Are we on track?</h2>
<p class="headline">${esc(trend.verdict === "baseline" ? "Baseline — this is the first measurement." : "Measured against earlier collections.")}</p>
<p>${esc(trend.basis)}</p>

<h2>What this pack does not cover</h2>
${coverageCallout(coverage)}

${appendices}

<footer>Standards data ${esc(pack.header.mappingDataVersion)} · generated ${esc(pack.header.generatedAt)}. Every figure is a count of what this inventory holds; nothing here states that anything unexamined is clean.</footer>`,
  );
}

// ── E2 ───────────────────────────────────────────────────────────────────────

function obligationBlock(
  obligations: RegulatorSubmission["inventory"][number]["obligations"],
  indicative: boolean,
): string {
  if (obligations.length === 0) return "";
  return `<table class="data"><thead><tr><th>Framework</th><th>Requirement</th><th>Deadline</th><th>Citation</th></tr></thead><tbody>${obligations
    .map((o) => {
      const deadline =
        o.deadline === null
          ? "—"
          : `${o.deadline.label}${o.deadline.effectiveFrom === null ? "" : ` from ${o.deadline.effectiveFrom}`}` +
            `${o.deadline.inEffect ? " (in effect)" : ""}${o.deadline.appliesTo === null ? "" : ` · applies to ${o.deadline.appliesTo}`}`;
      const retrieval =
        o.citation.retrievedAt === null
          ? '<span class="indicative">no retrieval date</span>'
          : `retrieved ${esc(o.citation.retrievedAt)}`;
      return (
        `<tr><td>${esc(o.frameworkName ?? o.framework)}${indicative ? '<span class="indicative">indicative</span>' : ""}` +
        `${o.draftStatus === null ? "" : `<span class="indicative">${esc(o.draftStatus)}</span>`}</td>` +
        `<td>${esc(o.requirement)}${o.caveats.length === 0 ? "" : `<div class="small">${o.caveats.map((c) => esc(c)).join(" ")}</div>`}</td>` +
        `<td class="small">${esc(deadline)}</td>` +
        `<td class="small">${esc(o.citation.document)}${o.citation.section === null ? "" : ` §${esc(o.citation.section)}`}` +
        `<div class="mono">${esc(o.citation.url)}</div>${retrieval}</td></tr>`
      );
    })
    .join("")}</tbody></table>`;
}

export function renderRegulatorSubmissionHtml(submission: RegulatorSubmission): string {
  const assets = submission.inventory
    .map(
      (asset) => `<div class="asset">
<h3>${esc(asset.algorithm)}${asset.keySize === null ? " (key size undetermined)" : ` ${esc(asset.keySize)}`} — ${esc(asset.surfaceName)}</h3>
<p class="mono">${esc(asset.location)}</p>
<table class="meta">
<tr><th>Fingerprint</th><td class="mono">${esc(asset.fingerprint)}</td></tr>
<tr><th>Status</th><td>${esc(asset.status)} · first seen ${esc(asset.firstSeen)} · last seen ${esc(asset.lastSeen)}</td></tr>
<tr><th>Says who</th><td>${
        asset.provenance.collector === null
          ? esc(asset.provenance.note)
          : `${esc(asset.provenance.collector)}@${esc(asset.provenance.collectorVersion)} · ` +
            `${esc(asset.provenance.discoveryModality)} · confidence ${esc(asset.provenance.confidence)} · ` +
            `observed ${esc(asset.provenance.observedAt)} · ${esc(asset.provenance.observations)} observation(s)`
      }</td></tr>
<tr><th>Secrecy lifetime (X)</th><td>${esc(asset.classification.secrecyLifetimeYears)} years, source ${esc(
        asset.classification.source,
      )}${asset.classification.assumed ? '<span class="assumed">assumed</span>' : ""}</td></tr>
<tr><th>Mosca</th><td>${
        asset.mosca.applicable
          ? asset.mosca.breachedScenarios.length === 0
            ? "Within the migration window under every scenario."
            : `Breached under: ${esc(asset.mosca.breachedScenarios.join(", "))}`
          : "Not applicable — this asset carries no quantum-vulnerable cryptography."
      }</td></tr>
${asset.keySizeNote === null ? "" : `<tr><th>Key size</th><td class="small">${esc(asset.keySizeNote)}</td></tr>`}
</table>
${obligationBlock(asset.obligations, false)}
${
  asset.indicativeObligations.length === 0
    ? ""
    : `<p class="small"><strong>${esc(submission.complianceClaimSummary.indicativeLabel)}</strong> — the following are not verified claims and must not be counted toward any compliance figure.</p>${obligationBlock(
        asset.indicativeObligations,
        true,
      )}`
}
${asset.caveats.length === 0 ? "" : `<ul class="small">${asset.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`}
</div>`,
    )
    .join("");

  return page(
    "Cryptographic inventory submission",
    `<h1>Cryptographic inventory submission</h1>
<p class="subtitle">Regulator and auditor pack · every asset with its provenance, every claim with its citation</p>
${headerTable(submission.header)}

<h2>Coverage limitations</h2>
${coverageCallout(submission.coverageLimitations)}
${
  submission.coverageLimitations.unmappedAlgorithms.length === 0
    ? ""
    : `<p class="small">Algorithms with no entry in the standards data: ${esc(
        submission.coverageLimitations.unmappedAlgorithms.join(", "),
      )}.</p>`
}

<h2>Scope</h2>
<table class="meta">
<tr><th>Assets included</th><td>${esc(submission.scope.assetsIncluded)}</td></tr>
<tr><th>Assets excluded</th><td>${esc(submission.scope.assetsExcluded)} — ${esc(submission.scope.exclusionBasis)}</td></tr>
<tr><th>By status</th><td>${esc(
      Object.entries(submission.scope.statusCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([status, count]) => `${status}: ${count}`)
        .join(" · ") || "none",
    )}</td></tr>
<tr><th>Projects</th><td>${esc(
      submission.scope.projects.map((p) => `${p.name} (${p.assets})`).join(" · ") || "none",
    )}</td></tr>
</table>

<h2>Compliance claims</h2>
<table class="data"><thead><tr><th>Measure</th><th>Count</th></tr></thead><tbody>
<tr><td>Verified obligations stated</td><td class="num">${esc(submission.complianceClaimSummary.verifiedObligations)}</td></tr>
<tr><td>Indicative obligations, shown separately and counted toward nothing</td><td class="num">${esc(submission.complianceClaimSummary.indicativeObligations)}</td></tr>
<tr><td>Assets carrying at least one verified obligation</td><td class="num">${esc(submission.complianceClaimSummary.assetsWithVerifiedObligations)}</td></tr>
<tr><td>Assets whose obligations are all indicative</td><td class="num">${esc(submission.complianceClaimSummary.assetsWithIndicativeObligationsOnly)}</td></tr>
<tr><td>Assets with no entry in the standards data at all</td><td class="num">${esc(submission.complianceClaimSummary.assetsWithNoStandardsEntry)}</td></tr>
<tr><td>Citations carrying no retrieval date</td><td class="num">${esc(submission.complianceClaimSummary.obligationsMissingRetrievalDate)}</td></tr>
</tbody></table>

<h2>Exceptions and waivers</h2>
<div class="callout"><p>${esc(submission.exceptions.statement)}</p>
${
  submission.exceptions.waivers.length === 0
    ? "<p class=\"small\">The register holds no waiver in force over this inventory.</p>"
    : `<table class="data"><thead><tr><th>Algorithm</th><th>Surface</th><th>Location</th><th>Justification</th><th>Signed off by</th><th>Expires</th></tr></thead><tbody>${submission.exceptions.waivers
        .map(
          (w) =>
            `<tr><td>${esc(w.algorithm)}</td><td>${esc(w.surface)}</td><td class="mono">${esc(w.location)}</td><td>${esc(w.justification)}</td><td>${esc(w.signedOffBy)}${
              // An asserted name is not an attributed one, and a printed page is
              // exactly where that difference stops being visible unless it is said.
              w.attribution === "asserted" ? " <span class=\"small\">(asserted, not authenticated)</span>" : ""
            }</td><td>${esc(w.expiresAt)}</td></tr>`,
        )
        .join("")}</tbody></table>`
}
${
  submission.exceptions.statusWaivedWithoutRegisterEntry.length === 0
    ? ""
    : `<p class="small">${esc(submission.exceptions.statusWaivedWithoutRegisterEntry.length)} asset(s) carry a <code>waived</code> status with no register entry behind it — no justification, no signatory, no expiry. They are not approved exceptions:</p><table class="data"><thead><tr><th>Algorithm</th><th>Surface</th><th>Location</th></tr></thead><tbody>${submission.exceptions.statusWaivedWithoutRegisterEntry
        .map(
          (w) =>
            `<tr><td>${esc(w.algorithm)}</td><td>${esc(w.surface)}</td><td class="mono">${esc(w.location)}</td></tr>`,
        )
        .join("")}</tbody></table>`
}
<p class="small">Assets a later collection confirmed absent: ${esc(submission.exceptions.removedAssets)}.</p></div>

<h2 class="page-break">Methodology</h2>
<h3>Collectors</h3>
<table class="data"><thead><tr><th>Collector</th><th>Version</th><th>Surface</th><th>Completed runs</th><th>Failed</th><th>Last run</th><th>Observations</th></tr></thead><tbody>${
      submission.methodology.collectors.length === 0
        ? '<tr><td colspan="7">No collection run has been recorded.</td></tr>'
        : submission.methodology.collectors
            .map(
              (c) =>
                `<tr><td>${esc(c.collector)}</td><td>${esc(c.collectorVersion)}</td><td>${esc(c.surface)}</td>` +
                `<td class="num">${esc(c.completedRuns)}</td><td class="num">${esc(c.failedRuns)}</td>` +
                `<td class="small">${esc(c.lastRunAt ?? "—")}</td><td class="num">${esc(c.observations)}</td></tr>`,
            )
            .join("")
    }</tbody></table>
<h3>Evidence</h3>
<p class="small">${esc(submission.methodology.confidenceBasis)}</p>
<ul class="small">${submission.methodology.discoveryModalities
      .map((m) => `<li>${esc(m.modality)} — ${esc(m.observations)} observation(s)</li>`)
      .join("")}</ul>
<h3>Known limits of detection</h3>
<ul class="small">${submission.methodology.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>

<h2>Assumptions</h2>
${assumptionsTable(submission.assumptions)}

<h2 class="page-break">Inventory</h2>
${assets === "" ? "<p>This inventory currently holds no present assets.</p>" : assets}

<h2>Integrity</h2>
<div class="callout neutral"><p>${esc(submission.integrity.statement)}</p>
<p class="mono">${esc(submission.integrity.digestAlgorithm)}: ${esc(submission.integrity.digest)}</p></div>

<footer>Standards data ${esc(submission.header.mappingDataVersion)} · generated ${esc(
      submission.header.generatedAt,
    )}. Obligations were resolved at read time against that version and are not stored against any asset.</footer>`,
  );
}
