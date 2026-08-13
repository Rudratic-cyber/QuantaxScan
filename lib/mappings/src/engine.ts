import type {
  AlgorithmEntry,
  DeadlineEntry,
  FrameworkEntry,
  MappingData,
} from "./schema";
import type {
  Citation,
  ComplianceStatus,
  CustomerProfile,
  DeadlineEffect,
  DetectionQualifier,
  MappingEngine,
  MappingInput,
  MappingResult,
  Obligation,
  ObligationDeadline,
  ObligationSeverity,
  ReportBucket,
  ResolveOptions,
  UseCondition,
} from "./types";

/**
 * C1 — the data-driven mapping engine.
 *
 * `resolve(observation, asOf)` is a pure function of `(input, data, asOf, profile)`.
 * Same inputs, same output, always — which is what makes a historical report
 * reproducible once the `dataVersion` it used is pinned alongside it.
 *
 * **The rule this file exists to obey:** no algorithm name, no date, no citation and
 * no standards claim is written here. Every one of those comes from
 * `docs/Claude/mappings/*.json`. The deadline-type vocabulary itself
 * (`disallowed`, `not-approved`, `legacy-use`, ...) is data too — see the
 * `deadlineTypes` block in `algorithms.json` — so a standards update that introduces
 * a new kind of rule is still a JSON pull request. If a date change ever requires
 * editing this file, the M2 exit criterion has been broken.
 *
 * What *is* here: the composition grammar (how a requirement sentence is assembled
 * from data fields), the date arithmetic, and the bucketing rules.
 */

export class MappingVersionError extends Error {
  constructor(requested: string, loaded: string) {
    super(
      `Mapping data version ${requested} was requested but ${loaded} is loaded. ` +
        `Historical reports must be regenerated against the data version they were pinned to; ` +
        `this engine loads exactly one version at a time.`,
    );
    this.name = "MappingVersionError";
  }
}

/** Unknown deadline types are neither ignored nor treated as prohibitions — see `deadlineSemantics`. */
const UNKNOWN_DEADLINE_EFFECT: DeadlineEffect = "caution";

const SEVERITY_VALUES: ObligationSeverity[] = ["critical", "high", "medium", "informational"];

function toSeverity(value: string | undefined, fallback: ObligationSeverity): ObligationSeverity {
  return SEVERITY_VALUES.find((s) => s === value) ?? fallback;
}

function toDate(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return new Date();
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Is a rule binding at `asOf`?
 *
 * `after: "2030"` — binding from 2031-01-01 (the standards say "disallowed *after* 2030").
 * `in: "2030"`    — binding from 2030-01-01.
 * `since: <date>` — binding from that date.
 * none of them    — binding now: the rule is in the standard with no transition window,
 *                   which is how SHA-1's §9 rules and MD5's never-approved status are recorded.
 */
function isInEffect(deadline: DeadlineEntry, asOf: Date): boolean {
  if (deadline.since) return asOf >= new Date(deadline.since);
  if (deadline.in) return asOf >= new Date(`${deadline.in}-01-01T00:00:00Z`);
  if (deadline.after) return asOf > new Date(`${deadline.after}-12-31T23:59:59Z`);
  return true;
}

function dateClause(deadline: DeadlineEntry): string {
  if (deadline.since) return ` since ${deadline.since}`;
  if (deadline.in) return ` in ${deadline.in}`;
  if (deadline.after) return ` after ${deadline.after}`;
  return "";
}

/** True when the framework's declared applicability covers the customer profile. */
function frameworkApplies(framework: FrameworkEntry | undefined, profile: CustomerProfile | undefined): boolean {
  const applicability = framework?.applicability;
  if (!applicability) return true; // no declared restriction — universally applicable

  const axisApplies = (declared: string[], value: string | undefined): boolean => {
    if (declared.includes("*")) return true;
    // A restricted axis with no declared customer value stays hidden: showing a UK bank a
    // CNSA 2.0 obligation is the over-claim doc 05 explicitly forbids.
    return value !== undefined && declared.includes(value);
  };

  return (
    axisApplies(applicability.jurisdictions, profile?.jurisdiction) &&
    axisApplies(applicability.sectors, profile?.sector) &&
    axisApplies(applicability.systemTypes, profile?.systemType)
  );
}

export function createMappingEngine(data: MappingData): MappingEngine {
  const byLookupKey = new Map<string, AlgorithmEntry>();
  for (const entry of data.algorithms.algorithms) {
    for (const key of [entry.canonicalName, entry.id, ...entry.aliases]) {
      const normalised = key.toLowerCase();
      if (!byLookupKey.has(normalised)) byLookupKey.set(normalised, entry);
    }
  }

  const frameworksById = new Map<string, FrameworkEntry>(data.frameworks.frameworks.map((f) => [f.id, f]));

  /** Resolve a deadline's `type` against the data's own vocabulary. */
  function deadlineSemantics(type: string): { label: string; effect: DeadlineEffect; severity?: string; known: boolean } {
    const declared = data.algorithms.deadlineTypes[type];
    if (declared) return { label: declared.label, effect: declared.effect, severity: declared.severity, known: true };
    // A data PR introduced a term the vocabulary block does not define. Surface it rather
    // than dropping it, but never let an undefined term manufacture a compliance failure.
    return { label: type, effect: UNKNOWN_DEADLINE_EFFECT, known: false };
  }

  function frameworkCaveats(framework: FrameworkEntry | undefined): string[] {
    if (!framework) return [];
    return [framework.customerFacingRule, framework.BLOCKER, framework.applicabilityWarning].filter(
      (c): c is string => typeof c === "string" && c.length > 0,
    );
  }

  function deadlineObligations(entry: AlgorithmEntry, asOf: Date, profile: CustomerProfile | undefined): Obligation[] {
    const obligations: Obligation[] = [];

    for (const deadline of entry.deadlines) {
      const framework = frameworksById.get(deadline.framework);
      if (!frameworkApplies(framework, profile)) continue;

      const semantics = deadlineSemantics(deadline.type);
      const inEffect = isInEffect(deadline, asOf);
      const scope = deadline.appliesTo ?? deadline.securityStrength ?? "all uses";

      const resolved: ObligationDeadline = {
        type: deadline.type,
        label: semantics.label,
        effect: semantics.effect,
        inEffect,
        after: deadline.after,
        in: deadline.in,
        since: deadline.since,
        appliesTo: deadline.appliesTo,
        securityStrength: deadline.securityStrength,
        source: deadline.source,
        note: deadline.note,
      };

      const strengthClause = deadline.securityStrength ? ` at ${deadline.securityStrength}` : "";
      const requirement =
        `${entry.canonicalName}${strengthClause} is ${semantics.label.toLowerCase()} for ${scope}` +
        `${dateClause(deadline)} under ${framework?.name ?? deadline.framework}.`;

      const caveats = frameworkCaveats(framework);
      if (deadline.note) caveats.push(deadline.note);
      if (!semantics.known) {
        caveats.push(
          `Deadline type "${deadline.type}" is not defined in algorithms.json's deadlineTypes block; ` +
            `treated conservatively and not counted as a compliance failure.`,
        );
      }

      obligations.push({
        framework: deadline.framework,
        frameworkName: framework?.name,
        requirement,
        severity: toSeverity(semantics.severity, semantics.effect === "permitted" ? "informational" : "high"),
        deadline: resolved,
        citation: {
          document: entry.citation.document,
          section: deadline.source ?? entry.citation.section,
          url: entry.citation.url,
          retrievedAt: entry.citation.retrievedAt,
          published: entry.citation.published,
        },
        confidence: deadline.confidence ?? entry.confidence ?? "needs-check",
        draftStatus: framework?.status?.includes("DRAFT") ? framework.status : undefined,
        caveats,
        source: "algorithm-deadline",
      });
    }

    return obligations;
  }

  function replacementObligations(entry: AlgorithmEntry, profile: CustomerProfile | undefined): Obligation[] {
    if (entry.replacements.length === 0) return [];

    // Replacements name a target standard rather than a framework id; the framework that
    // owns "the approved replacement algorithms" is whichever entry declares that role.
    const targetFramework = data.frameworks.frameworks.find((f) => f.id === "NIST-FIPS");
    if (!frameworkApplies(targetFramework, profile)) return [];

    return entry.replacements.map((replacement) => ({
      framework: targetFramework?.id ?? "NIST-FIPS",
      frameworkName: targetFramework?.name,
      requirement: replacement.purpose
        ? `Migrate ${replacement.purpose} away from ${entry.canonicalName} to ${replacement.algorithm} (${replacement.standard}).`
        : `Replace ${entry.canonicalName} with ${replacement.algorithm} (${replacement.standard}).`,
      severity: "high" as ObligationSeverity,
      replacement: {
        algorithm: replacement.algorithm,
        standard: replacement.standard,
        purpose: replacement.purpose,
        note: replacement.note,
      },
      citation: {
        document: replacement.standard,
        url: targetFramework?.url ?? entry.citation.url,
        retrievedAt: targetFramework?.retrievedAt ?? entry.citation.retrievedAt,
      },
      confidence: targetFramework?.confidence ?? "needs-check",
      caveats: [...frameworkCaveats(targetFramework), replacement.note].filter((c): c is string => Boolean(c)),
      source: "algorithm-replacement" as const,
    }));
  }

  /**
   * G-09. An entry with a `bestPractice` block and no prohibition is a hygiene
   * recommendation, not a compliance finding — and its citation is the document that
   * *approves* the construct, so an auditor checking it finds agreement, not a
   * contradiction.
   */
  function bestPracticeObligations(entry: AlgorithmEntry): Obligation[] {
    if (!entry.bestPractice) return [];
    const bp = entry.bestPractice;
    return [
      {
        framework: "best-practice",
        frameworkName: "Cryptographic best practice (not a compliance requirement)",
        requirement: bp.requirement,
        severity: toSeverity(bp.severity, "medium"),
        citation: bp.citation ?? { document: entry.citation.document, url: entry.citation.url, retrievedAt: entry.citation.retrievedAt },
        confidence: bp.confidence ?? entry.confidence ?? "needs-check",
        caveats: bp.basis ? [bp.basis] : [],
        source: "algorithm-best-practice",
      },
    ];
  }

  function frameworkObligations(entry: AlgorithmEntry, profile: CustomerProfile | undefined): Obligation[] {
    const obligations: Obligation[] = [];

    for (const framework of data.frameworks.frameworks) {
      if (framework.findingObligations.length === 0) continue;
      if (!frameworkApplies(framework, profile)) continue;

      for (const rule of framework.findingObligations) {
        const match = rule.match;
        if (match.quantumVulnerable !== undefined && match.quantumVulnerable !== entry.quantumVulnerable) continue;
        if (match.algorithmIds && !match.algorithmIds.includes(entry.id)) continue;
        if (match.families && (!entry.family || !match.families.includes(entry.family))) continue;
        if (match.purposes && !entry.purposes.some((p) => match.purposes!.includes(p))) continue;

        const caveats = frameworkCaveats(framework);
        if (rule.caveat) caveats.push(rule.caveat);
        if (rule.deadlineNote) caveats.push(rule.deadlineNote);

        obligations.push({
          framework: framework.id,
          frameworkName: framework.name,
          requirement: rule.requirement,
          severity: toSeverity(rule.severity, "medium"),
          citation: rule.citation,
          confidence: rule.confidence ?? framework.confidence ?? "needs-check",
          draftStatus: framework.status?.includes("DRAFT") ? framework.status : undefined,
          caveats,
          source: "framework",
        });
      }
    }

    return obligations;
  }

  function classify(obligations: Obligation[]): ComplianceStatus {
    const deadlines = obligations.map((o) => o.deadline).filter((d): d is ObligationDeadline => Boolean(d));
    if (deadlines.some((d) => d.effect === "prohibition" && d.inEffect)) return "immediate-failure";
    if (deadlines.some((d) => (d.effect === "prohibition" || d.effect === "caution") && !d.inEffect))
      return "future-obligation";
    if (deadlines.some((d) => d.effect === "caution" && d.inEffect)) return "future-obligation";
    return "no-obligation";
  }

  function bucketFor(entry: AlgorithmEntry, status: ComplianceStatus): ReportBucket {
    // G-07: an in-effect prohibition outranks the PQC horizon. A DSA signing site is
    // non-compliant today; filing it under "2035 migration" understates it.
    if (status === "immediate-failure") return "immediate-compliance-failure";
    if (entry.quantumVulnerable) return "pqc-migration";
    if (status === "future-obligation") return "classical-hygiene";
    if (entry.bestPractice) return "best-practice";
    return "no-obligation";
  }

  /**
   * G-08. When the data records both prohibited and permitted uses for the same
   * algorithm, the honest report is a table of uses, not a verdict on the algorithm.
   */
  function useConditionsFor(obligations: Obligation[]): UseCondition[] {
    return obligations
      .filter((o) => o.deadline?.appliesTo)
      .map((o) => ({
        use: o.deadline!.appliesTo!,
        status: o.deadline!.label,
        permitted: o.deadline!.effect === "permitted",
        framework: o.frameworkName ?? o.framework,
      }));
  }

  function headlineFor(entry: AlgorithmEntry, status: ComplianceStatus, obligations: Obligation[], useDependent: boolean): string {
    if (status === "immediate-failure") {
      const binding = obligations.filter((o) => o.deadline?.effect === "prohibition" && o.deadline.inEffect);
      const sentence = binding.map((o) => o.requirement).join(" ");
      const tail = useDependent
        ? " Other uses of this algorithm remain permitted — confirm which applies before treating this finding as a failure."
        : " There is no migration runway: this is a present-tense compliance failure.";
      return sentence + tail;
    }

    if (status === "future-obligation") {
      const scheduled = obligations.filter((o) => o.deadline && !o.deadline.inEffect);
      return (scheduled.length > 0 ? scheduled : obligations.filter((o) => o.deadline)).map((o) => o.requirement).join(" ");
    }

    if (entry.complianceStatus) return entry.complianceStatus;
    if (entry.bestPractice) return entry.bestPractice.requirement;
    return `No standards obligation is recorded for ${entry.canonicalName} in the loaded mapping data.`;
  }

  function detectionFor(entry: AlgorithmEntry, input: MappingInput): DetectionQualifier {
    const declared = entry.detectionConfidence;
    const multiplier = declared?.multiplier ?? 1;
    return {
      multiplier,
      adjustedConfidence: typeof input.confidence === "number" ? input.confidence * multiplier : undefined,
      reviewRequired: declared?.reviewRequired ?? false,
      reason: declared?.reason ?? null,
    };
  }

  return {
    dataVersion: data.algorithms.dataVersion,
    frameworksDataVersion: data.frameworks.dataVersion,

    listAlgorithms: () => data.algorithms.algorithms.map((a) => a.canonicalName),

    resolve(input: MappingInput, options: ResolveOptions = {}): MappingResult | undefined {
      if (options.version && options.version !== data.algorithms.dataVersion) {
        throw new MappingVersionError(options.version, data.algorithms.dataVersion);
      }

      const entry = byLookupKey.get(input.algorithm.toLowerCase());
      if (!entry) return undefined;

      const asOf = toDate(options.asOf);
      const profile = options.profile;

      const obligations = [
        ...deadlineObligations(entry, asOf, profile),
        ...replacementObligations(entry, profile),
        ...bestPracticeObligations(entry),
        ...frameworkObligations(entry, profile),
      ];

      const status = classify(obligations);
      const useConditions = useConditionsFor(obligations);
      const useDependent =
        useConditions.some((u) => u.permitted) && useConditions.some((u) => !u.permitted);

      const caveats = [
        ...new Set(
          [data.algorithms.criticalCaveat, ...obligations.flatMap((o) => o.caveats)].filter(
            (c): c is string => typeof c === "string" && c.length > 0,
          ),
        ),
      ];

      const citation: Citation = {
        document: entry.citation.document,
        section: entry.citation.section,
        url: entry.citation.url,
        retrievedAt: entry.citation.retrievedAt,
        published: entry.citation.published,
      };

      return {
        algorithm: entry.canonicalName,
        algorithmId: entry.id,
        quantumVulnerable: entry.quantumVulnerable,
        riskTrack: entry.quantumVulnerable ? "post-quantum" : "classical-hygiene",
        complianceStatus: status,
        bucket: bucketFor(entry, status),
        headline: headlineFor(entry, status, obligations, useDependent),
        useDependent,
        useConditions,
        obligations,
        detection: detectionFor(entry, input),
        reportingNote: entry.reportingNote ?? null,
        caveats,
        citation,
        dataVersion: data.algorithms.dataVersion,
        asOf: isoDay(asOf),
      };
    },
  };
}
