/**
 * Minimal internal CPE 2.3 formatted-string parser/formatter/validator.
 *
 * Source: NIST IR 7695, "Common Platform Enumeration: Naming Specification
 * Version 2.3" — §5.3.3 (binding rules) and §6.2–6.2.3 (formatted string
 * binding), https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir7695.pdf
 * [verified; retrievedAt: 2026-08-02 — see qx-sp1800-38b investigation report]
 *
 * The qx-sp1800-38b investigation checked the npm ecosystem and found no
 * well-maintained CPE 2.3 parser/formatter/matcher for Node/TypeScript (the
 * closest candidate was last published 2022-04-07). Rather than add an
 * unreviewed dependency to a security product's trust path, this module
 * implements only the formatted-string binding (parse/format/validate),
 * deliberately not full CPE name matching or dictionary resolution — those
 * are a separate follow-up (see docs/Claude/09-open-gaps.md G-15).
 *
 * A CPE 2.3 formatted-string binding has exactly eleven colon-delimited
 * attributes after the `cpe:2.3:` prefix: part, vendor, product, version,
 * update, edition, language, sw_edition, target_sw, target_hw, other.
 * `part` is `a` (application), `o` (operating system), or `h` (hardware).
 * `*` means ANY and `-` means N/A. Reserved characters — including a literal
 * colon inside an attribute value — must be backslash-escaped, so a naive
 * `split(":")` silently fragments a single escaped attribute into two.
 */

export type CpePart = "a" | "o" | "h";

/** Branded CPE 2.3 formatted string — only constructed via a validating function in this module. */
export type Cpe23FormattedString = string & { readonly __brand: "Cpe23FormattedString" };

export interface Cpe23Attributes {
  part: CpePart;
  vendor: string;
  product: string;
  version: string;
  update: string;
  edition: string;
  language: string;
  swEdition: string;
  targetSw: string;
  targetHw: string;
  other: string;
}

export class Cpe23ParseError extends Error {}

const CPE_PREFIX = "cpe:2.3:";
const ATTRIBUTE_COUNT = 11;

/**
 * Split a CPE 2.3 formatted-string body on unescaped colons only.
 * `\:` inside an attribute is a literal colon, not a delimiter.
 */
function splitUnescaped(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      current += ch + body[i + 1];
      i++;
      continue;
    }
    if (ch === ":") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

export function parseCpe23FormattedString(input: string): Cpe23Attributes {
  if (!input.startsWith(CPE_PREFIX)) {
    throw new Cpe23ParseError(`Not a CPE 2.3 formatted string (must start with "${CPE_PREFIX}"): ${input}`);
  }
  const body = input.slice(CPE_PREFIX.length);
  const fields = splitUnescaped(body);
  if (fields.length !== ATTRIBUTE_COUNT) {
    throw new Cpe23ParseError(
      `Expected ${ATTRIBUTE_COUNT} colon-delimited attributes after "${CPE_PREFIX}", got ${fields.length}: ${input}`,
    );
  }
  const [part, vendor, product, version, update, edition, language, swEdition, targetSw, targetHw, other] = fields;
  if (part !== "a" && part !== "o" && part !== "h") {
    throw new Cpe23ParseError(`CPE 2.3 "part" must be one of a/o/h, got "${part}": ${input}`);
  }
  return { part, vendor, product, version, update, edition, language, swEdition, targetSw, targetHw, other };
}

/**
 * Escape a bare, unescaped colon in an attribute value. Callers are expected
 * to supply values with any other required reserved-character escaping
 * already applied (IR 7695 §6.2.3: discovered versions are copied, not
 * truncated or modified, with required escaping) — this is a safety net for
 * the one character this module exists to get right, not a full escaper for
 * every CPE-reserved character.
 */
function escapeUnescapedColons(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      out += ch + value[i + 1];
      i++;
      continue;
    }
    out += ch === ":" ? "\\:" : ch;
  }
  return out;
}

export function formatCpe23FormattedString(attrs: Cpe23Attributes): Cpe23FormattedString {
  const ordered = [
    attrs.part,
    attrs.vendor,
    attrs.product,
    attrs.version,
    attrs.update,
    attrs.edition,
    attrs.language,
    attrs.swEdition,
    attrs.targetSw,
    attrs.targetHw,
    attrs.other,
  ];
  return (CPE_PREFIX + ordered.map(escapeUnescapedColons).join(":")) as Cpe23FormattedString;
}

/**
 * Validate a string as a CPE 2.3 formatted string, optionally requiring a
 * specific `part`. Used at the `locationDetail` boundary: absence is always
 * allowed (an unidentifiable software/OS/vendor is normal, per the
 * investigation's "never silently pick one" CPE rule), but a present value
 * must be well-formed.
 */
export function isValidCpe23FormattedString(input: string, expectedPart?: CpePart): input is Cpe23FormattedString {
  try {
    const attrs = parseCpe23FormattedString(input);
    if (expectedPart && attrs.part !== expectedPart) return false;
    return true;
  } catch {
    return false;
  }
}
