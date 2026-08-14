import algorithmsJson from "../../../docs/Claude/mappings/algorithms.json" with { type: "json" };
import frameworksJson from "../../../docs/Claude/mappings/frameworks.json" with { type: "json" };
import { parseMappingData, type MappingData } from "./schema";

/**
 * The bundled standards data.
 *
 * Imported as JSON modules so esbuild inlines both files into the API bundle at build
 * time — there is no runtime filesystem read to get wrong across the Docker
 * build/deploy boundary. The trade-off, recorded in `docs/Claude/mappings/README.md`,
 * is that a data edit needs a rebuild and redeploy to take effect. That is a *deploy*
 * step, not a code change, so the M2 exit criterion still holds.
 *
 * Validation runs at module initialisation, i.e. at API boot: a malformed
 * `algorithms.json` fails loudly on startup instead of turning into a missing
 * obligation halfway through a customer's report.
 *
 * Nothing else in this package reads these imports. The engine takes its data as an
 * argument (`createMappingEngine`), which is what lets the test suite feed it a
 * mutated copy and prove that changing a date changes the output with no TypeScript
 * edit — see `engine.test.ts`.
 */
export const defaultMappingData: MappingData = parseMappingData(algorithmsJson, frameworksJson);
