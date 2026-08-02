import { describe, expect, it } from "vitest";
import { parseCpe23FormattedString, formatCpe23FormattedString, isValidCpe23FormattedString, Cpe23ParseError } from "./cpe";

describe("parseCpe23FormattedString", () => {
  it("parses the worked example from NIST IR 7695 / the qx-sp1800-38b investigation report", () => {
    // cpe:2.3:a:microsoft:internet_explorer:8.0.6001:beta:*:*:*:*:*:*
    const attrs = parseCpe23FormattedString("cpe:2.3:a:microsoft:internet_explorer:8.0.6001:beta:*:*:*:*:*:*");
    expect(attrs).toEqual({
      part: "a",
      vendor: "microsoft",
      product: "internet_explorer",
      version: "8.0.6001",
      update: "beta",
      edition: "*",
      language: "*",
      swEdition: "*",
      targetSw: "*",
      targetHw: "*",
      other: "*",
    });
  });

  it("rejects a part other than a/o/h", () => {
    expect(() => parseCpe23FormattedString("cpe:2.3:x:vendor:product:1.0:*:*:*:*:*:*:*")).toThrow(Cpe23ParseError);
  });

  it("rejects a string missing the cpe:2.3 prefix", () => {
    expect(() => parseCpe23FormattedString("a:vendor:product:1.0:*:*:*:*:*:*:*")).toThrow(Cpe23ParseError);
  });

  it("rejects the wrong attribute count", () => {
    expect(() => parseCpe23FormattedString("cpe:2.3:a:vendor:product")).toThrow(Cpe23ParseError);
    expect(() => parseCpe23FormattedString("cpe:2.3:a:vendor:product:1.0:*:*:*:*:*:*:*:extra")).toThrow(
      Cpe23ParseError,
    );
  });

  it("does not fragment an attribute on an escaped colon — the failure mode a naive split(':') has", () => {
    // A version string containing a literal, backslash-escaped colon.
    const input = "cpe:2.3:a:acme:widget:1\\:2:*:*:*:*:*:*:*";
    const naiveSplitCount = input.slice("cpe:2.3:".length).split(":").length;
    expect(naiveSplitCount).not.toBe(11); // demonstrates naive split(":") is wrong here (12 fields)

    const attrs = parseCpe23FormattedString(input);
    expect(attrs.version).toBe("1\\:2");
    expect(attrs.vendor).toBe("acme");
    expect(attrs.product).toBe("widget");
  });
});

describe("formatCpe23FormattedString / round-trip", () => {
  it("round-trips parse -> format -> parse", () => {
    const original = "cpe:2.3:o:cisco:ios:12.4:*:*:*:*:*:*:*";
    const attrs = parseCpe23FormattedString(original);
    const formatted = formatCpe23FormattedString(attrs);
    expect(formatted).toBe(original);
    expect(parseCpe23FormattedString(formatted)).toEqual(attrs);
  });

  it("escapes a bare unescaped colon on format", () => {
    const formatted = formatCpe23FormattedString({
      part: "a",
      vendor: "acme",
      product: "widget",
      version: "1:2", // deliberately unescaped
      update: "*",
      edition: "*",
      language: "*",
      swEdition: "*",
      targetSw: "*",
      targetHw: "*",
      other: "*",
    });
    expect(formatted).toContain("1\\:2");
    // and it must still parse back to 11 attributes, not 12
    expect(parseCpe23FormattedString(formatted).version).toBe("1\\:2");
  });
});

describe("isValidCpe23FormattedString", () => {
  it("validates part when a specific part is required (the 'Device Vendor' qualification)", () => {
    const softwareCpe = "cpe:2.3:a:acme:widget:1.0:*:*:*:*:*:*:*";
    expect(isValidCpe23FormattedString(softwareCpe, "a")).toBe(true);
    expect(isValidCpe23FormattedString(softwareCpe, "o")).toBe(false);
    expect(isValidCpe23FormattedString(softwareCpe, "h")).toBe(false);
  });

  it("returns false rather than throwing on a malformed string", () => {
    expect(isValidCpe23FormattedString("not-a-cpe")).toBe(false);
  });
});
