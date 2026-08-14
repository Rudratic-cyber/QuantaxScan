import { z } from "zod/v4";

/**
 * Boot-time schema for the versioned standards data.
 *
 * Deliberately **lenient**: every object is loose (unknown keys pass through) and the
 * deadline-type vocabulary is an open `string`, not an enum. A standards update is
 * supposed to be a pull request against JSON — a data PR that adds a field, an
 * algorithm or a new deadline type must not fail the build or refuse to boot. What
 * this schema does enforce is the shape the engine actually dereferences, so a
 * malformed entry surfaces as a loud error at import time rather than as a silently
 * missing obligation in a customer's report. That is the gap
 * `docs/Claude/mappings/README.md` records as "nothing schema-validates it at boot".
 */

const citationSchema = z.looseObject({
  document: z.string(),
  section: z.string().optional(),
  url: z.string(),
  retrievedAt: z.string().optional(),
  published: z.string().optional(),
});

const deadlineSchema = z.looseObject({
  framework: z.string(),
  /** Open vocabulary — resolved against `deadlineTypes`, unknown terms degrade gracefully. */
  type: z.string(),
  after: z.string().optional(),
  in: z.string().optional(),
  since: z.string().optional(),
  appliesTo: z.string().optional(),
  securityStrength: z.string().optional(),
  source: z.string().optional(),
  note: z.string().optional(),
  confidence: z.string().optional(),
});

const replacementSchema = z.looseObject({
  purpose: z.string().optional(),
  algorithm: z.string(),
  standard: z.string(),
  note: z.string().optional(),
});

const detectionConfidenceSchema = z.looseObject({
  multiplier: z.number().min(0).max(1),
  reviewRequired: z.boolean().optional(),
  reason: z.string().optional(),
});

const bestPracticeSchema = z.looseObject({
  requirement: z.string(),
  severity: z.string().optional(),
  basis: z.string().optional(),
  citation: citationSchema.optional(),
  confidence: z.string().optional(),
});

const algorithmSchema = z.looseObject({
  id: z.string(),
  canonicalName: z.string(),
  aliases: z.array(z.string()).default([]),
  family: z.string().optional(),
  /** Which band range a stated key size is read against. Mirrors the collectors' KEY_SIZE_SOURCE. */
  keySizeKind: z.enum(["modulus", "curve"]).optional(),
  purposes: z.array(z.string()).default([]),
  quantumVulnerable: z.boolean(),
  baseEffortHours: z.number().optional(),
  replacements: z.array(replacementSchema).default([]),
  deadlines: z.array(deadlineSchema).default([]),
  citation: citationSchema,
  confidence: z.string().optional(),
  explanation: z.string().optional(),
  reportingNote: z.string().optional(),
  detectionNuance: z.string().optional(),
  detectionConfidence: detectionConfidenceSchema.optional(),
  complianceStatus: z.string().optional(),
  bestPractice: bestPracticeSchema.optional(),
});

const deadlineTypeSchema = z.looseObject({
  label: z.string(),
  effect: z.enum(["prohibition", "caution", "permitted"]),
  severity: z.string().optional(),
  definition: z.string().optional(),
});

/**
 * One security-strength band, and the parameter sizes that land in it.
 *
 * IR 8547 keys its transition rules on security strength; a collector reports a parameter size.
 * This is the bridge, and it is data rather than TypeScript so that a revision stays a JSON
 * pull request — the same rule as `deadlineTypes`.
 */
const strengthBandSchema = z.looseObject({
  /** MUST match the `securityStrength` string used by the deadlines, because the engine joins on it. */
  securityStrength: z.string(),
  /** The band assumed when a collector could not determine a key size (G-05). Exactly one should set it. */
  assumedWhenUndetermined: z.boolean().default(false),
  modulusBits: z.looseObject({ min: z.number(), max: z.number() }).optional(),
  curveBits: z.looseObject({ min: z.number(), max: z.number() }).optional(),
  examples: z.array(z.string()).default([]),
});

const securityStrengthBandsSchema = z.looseObject({
  bands: z.array(strengthBandSchema).default([]),
});

export const algorithmsDataSchema = z.looseObject({
  schemaVersion: z.string(),
  dataVersion: z.string(),
  criticalCaveat: z.string().optional(),
  deadlineTypes: z.record(z.string(), deadlineTypeSchema).default({}),
  securityStrengthBands: securityStrengthBandsSchema.optional(),
  algorithms: z.array(algorithmSchema),
});

const applicabilitySchema = z.looseObject({
  jurisdictions: z.array(z.string()).default(["*"]),
  sectors: z.array(z.string()).default(["*"]),
  systemTypes: z.array(z.string()).default(["*"]),
});

const findingObligationSchema = z.looseObject({
  id: z.string(),
  match: z
    .looseObject({
      quantumVulnerable: z.boolean().optional(),
      algorithmIds: z.array(z.string()).optional(),
      families: z.array(z.string()).optional(),
      purposes: z.array(z.string()).optional(),
    })
    .default({}),
  requirement: z.string(),
  severity: z.string().optional(),
  deadlineNote: z.string().optional(),
  citation: citationSchema,
  confidence: z.string().optional(),
  caveat: z.string().optional(),
});

const frameworkSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  publisher: z.string().optional(),
  status: z.string().optional(),
  applicability: applicabilitySchema.optional(),
  customerFacingRule: z.string().optional(),
  applicabilityWarning: z.string().optional(),
  BLOCKER: z.string().optional(),
  confidence: z.string().optional(),
  url: z.string().optional(),
  retrievedAt: z.string().optional(),
  findingObligations: z.array(findingObligationSchema).default([]),
});

export const frameworksDataSchema = z.looseObject({
  schemaVersion: z.string(),
  dataVersion: z.string(),
  frameworks: z.array(frameworkSchema),
});

export type AlgorithmsData = z.infer<typeof algorithmsDataSchema>;
export type FrameworksData = z.infer<typeof frameworksDataSchema>;
export type AlgorithmEntry = z.infer<typeof algorithmSchema>;
export type FrameworkEntry = z.infer<typeof frameworkSchema>;
export type DeadlineEntry = z.infer<typeof deadlineSchema>;
export type FindingObligationRule = z.infer<typeof findingObligationSchema>;

/** The two files the engine reads, already validated. */
export interface MappingData {
  algorithms: AlgorithmsData;
  frameworks: FrameworksData;
}

export class MappingDataError extends Error {
  constructor(file: string, cause: unknown) {
    super(`docs/Claude/mappings/${file} failed schema validation: ${String(cause)}`);
    this.name = "MappingDataError";
  }
}

/** Validate raw JSON into a `MappingData`. Throws `MappingDataError` on a malformed file. */
export function parseMappingData(algorithms: unknown, frameworks: unknown): MappingData {
  const parsedAlgorithms = algorithmsDataSchema.safeParse(algorithms);
  if (!parsedAlgorithms.success) throw new MappingDataError("algorithms.json", z.prettifyError(parsedAlgorithms.error));

  const parsedFrameworks = frameworksDataSchema.safeParse(frameworks);
  if (!parsedFrameworks.success) throw new MappingDataError("frameworks.json", z.prettifyError(parsedFrameworks.error));

  return { algorithms: parsedAlgorithms.data, frameworks: parsedFrameworks.data };
}
