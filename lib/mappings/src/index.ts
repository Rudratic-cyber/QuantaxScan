/**
 * `@workspace/mappings` — the C1 dynamic compliance mapping engine.
 *
 * Design and contract: docs/Claude/05-compliance-mapping.md.
 * Data: docs/Claude/mappings/{algorithms,frameworks}.json.
 *
 * Typical use — one call per finding, at read time:
 *
 * ```ts
 * import { mappingEngine } from "@workspace/mappings";
 * const mapping = mappingEngine.resolve({ algorithm: "DSA", confidence: 0.7 }, { asOf: new Date() });
 * ```
 */
export { createMappingEngine, MappingVersionError } from "./engine";
export { REPORT_BUCKET_META, RISK_TRACK_META, bucketOrder } from "./buckets";
export { parseMappingData, MappingDataError, type MappingData } from "./schema";
export { defaultMappingData } from "./data";
export type * from "./types";

import { createMappingEngine } from "./engine";
import { defaultMappingData } from "./data";

/**
 * The engine over the bundled, boot-validated standards data.
 *
 * Use this everywhere in the product. `createMappingEngine` exists for tests and for
 * a future pinned-version loader — see the versioning note in
 * docs/Claude/05-compliance-mapping.md.
 */
export const mappingEngine = createMappingEngine(defaultMappingData);
