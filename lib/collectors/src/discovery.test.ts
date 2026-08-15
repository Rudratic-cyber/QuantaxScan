import { describe, it, expect } from "vitest";
import {
  certificateExpired,
  DISCOVERY_EVIDENCE_CAVEAT,
  isWildcardName,
  isWithinDomain,
  MAX_DISCOVERED_HOSTNAMES_PER_RUN,
  normaliseHostname,
  parseCrtShResponse,
  parseCtTimestamp,
} from "./discovery";

/**
 * D8 — the discovery parser.
 *
 * This suite is weighted deliberately towards what the parser **refuses**.
 * A CT log is a public, unauthenticated firehose containing names that never
 * existed, names that expired years ago and names belonging to other people
 * entirely, so a suite of positive cases here would prove close to nothing:
 * the way this feature fails is by claiming an estate the customer does not
 * have, not by missing one.
 */

/** A crt.sh row with only the fields a given test cares about. */
function row(fields: Record<string, unknown>): Record<string, unknown> {
  return { id: 1, issuer_name: "C=US, O=Test CA", ...fields };
}

describe("normaliseHostname", () => {
  it("lowercases and strips the root dot, because DNS is case-insensitive and logs are not consistent", () => {
    expect(normaliseHostname("WWW.Example.COM.")).toBe("www.example.com");
    expect(normaliseHostname("  api.example.com  ")).toBe("api.example.com");
  });

  it("rejects rather than repairs", () => {
    // Every one of these could be "fixed" into something plausible. A repaired
    // name is a name nobody has evidence for.
    expect(normaliseHostname("")).toBeNull();
    expect(normaliseHostname("..")).toBeNull();
    expect(normaliseHostname("a..b.com")).toBeNull();
    expect(normaliseHostname("-lead.example.com")).toBeNull();
    expect(normaliseHostname("trail-.example.com")).toBeNull();
    expect(normaliseHostname("under_score.example.com")).toBeNull();
    expect(normaliseHostname("has space.example.com")).toBeNull();
    expect(normaliseHostname("http://example.com")).toBeNull();
    expect(normaliseHostname("example.com:443")).toBeNull();
    expect(normaliseHostname(`${"a".repeat(64)}.example.com`)).toBeNull();
    expect(normaliseHostname(`${"a.".repeat(140)}com`)).toBeNull();
  });

  it("rejects a single label — it can never be within a registered domain", () => {
    expect(normaliseHostname("localhost")).toBeNull();
    expect(normaliseHostname("intranet")).toBeNull();
  });

  it("rejects an IPv4 literal: this method discovers names, and a dotted quad is not one", () => {
    expect(normaliseHostname("192.0.2.10")).toBeNull();
    expect(normaliseHostname("10.0.0.1")).toBeNull();
  });
});

describe("isWithinDomain — the label-boundary rule", () => {
  it("accepts the domain itself and its subdomains", () => {
    expect(isWithinDomain("example.com", "example.com")).toBe(true);
    expect(isWithinDomain("www.example.com", "example.com")).toBe(true);
    expect(isWithinDomain("a.b.c.example.com", "example.com")).toBe(true);
  });

  /**
   * The negative control the lane brief demands: an unowned lookalike domain
   * must not be claimed. Every string below contains `example.com` and none of
   * them is within it. A `.includes()` or `.endsWith()` implementation passes
   * the block above and fails here, which is the point.
   */
  it("refuses a lookalike domain that merely contains the customer's", () => {
    expect(isWithinDomain("notexample.com", "example.com")).toBe(false);
    expect(isWithinDomain("myexample.com", "example.com")).toBe(false);
    expect(isWithinDomain("example.com.attacker.test", "example.com")).toBe(false);
    expect(isWithinDomain("example.community", "example.com")).toBe(false);
    expect(isWithinDomain("wwwexample.com", "example.com")).toBe(false);
  });
});

describe("isWildcardName", () => {
  it("recognises a wildcard, which covers a set of names and is evidence for none of them", () => {
    expect(isWildcardName("*.example.com")).toBe(true);
    expect(isWildcardName("  *.example.com")).toBe(true);
    expect(isWildcardName("www.example.com")).toBe(false);
  });
});

describe("parseCtTimestamp", () => {
  it("reads a timezone-less CT timestamp as UTC, not as the server's local time", () => {
    // RFC 6962 §3.2 log timestamps are UTC; reading `2024-03-01T12:00:00` as
    // local time would shift every certificate's validity by the deployment's
    // offset, which is how a valid certificate becomes an expired one.
    expect(parseCtTimestamp("2024-03-01T12:00:00")).toBe("2024-03-01T12:00:00.000Z");
    expect(parseCtTimestamp("2024-03-01 12:00:00")).toBe("2024-03-01T12:00:00.000Z");
  });

  it("honours an offset the source does state", () => {
    expect(parseCtTimestamp("2024-03-01T12:00:00Z")).toBe("2024-03-01T12:00:00.000Z");
    expect(parseCtTimestamp("2024-03-01T12:00:00+02:00")).toBe("2024-03-01T10:00:00.000Z");
  });

  it("returns null for anything it cannot read — a date this cannot parse is a date nobody should act on", () => {
    expect(parseCtTimestamp(undefined)).toBeNull();
    expect(parseCtTimestamp("")).toBeNull();
    expect(parseCtTimestamp("not a date")).toBeNull();
    expect(parseCtTimestamp(1_700_000_000)).toBeNull();
  });
});

describe("parseCrtShResponse", () => {
  const DOMAIN = "example.com";

  it("keeps in-scope names from the SAN list and the common name", () => {
    const result = parseCrtShResponse(
      [row({ name_value: "example.com\nwww.example.com", common_name: "example.com" })],
      DOMAIN,
    );
    expect(result.hostnames.map((h) => h.hostname)).toEqual(["example.com", "www.example.com"]);
    expect(result.entriesRead).toBe(1);
    expect(result.hostnames[0].method).toBe("certificate_transparency");
  });

  /**
   * The three ways a CT log offers a name this product must not present as the
   * customer's host — asserted together, because in a real response they
   * arrive together, in one SAN list.
   */
  it("drops a wildcard, someone else's domain, and an IP literal, each with its own reason", () => {
    const result = parseCrtShResponse(
      [
        row({
          name_value: "*.example.com\nwww.example.com\nshared-host.othercompany.test\n192.0.2.10",
        }),
      ],
      DOMAIN,
    );

    expect(result.hostnames.map((h) => h.hostname)).toEqual(["www.example.com"]);
    expect(result.rejected).toEqual([
      { rawName: "*.example.com", reason: "wildcard" },
      { rawName: "192.0.2.10", reason: "ip-literal" },
      { rawName: "shared-host.othercompany.test", reason: "out-of-scope" },
    ]);
    // Read and refused is visible, not silent: 4 names read, 1 kept.
    expect(result.namesRead).toBe(4);
  });

  /**
   * The load-bearing negative test. `attacker-example.com` and
   * `example.com.attacker.test` are certificates a *third party* obtained, and
   * they legitimately appear in a CT search whose query is a substring match.
   * Reporting either as the customer's host is the exact failure that makes a
   * CISO's number untrustworthy.
   */
  it("never claims a lookalike domain, even when the source returned it for this query", () => {
    const result = parseCrtShResponse(
      [
        row({ name_value: "attacker-example.com" }),
        row({ name_value: "example.com.attacker.test" }),
        row({ name_value: "notexample.com\nwww.notexample.com" }),
        row({ name_value: "real.example.com" }),
      ],
      DOMAIN,
    );

    expect(result.hostnames.map((h) => h.hostname)).toEqual(["real.example.com"]);
    expect(result.rejected.every((r) => r.reason === "out-of-scope")).toBe(true);
    expect(result.rejected.map((r) => r.rawName)).toEqual([
      "attacker-example.com",
      "example.com.attacker.test",
      "notexample.com",
      "www.notexample.com",
    ]);
  });

  it("carries the evidence verbatim and invents nothing the source omitted", () => {
    const result = parseCrtShResponse(
      [
        {
          id: 987654321,
          issuer_name: "C=US, O=Let's Encrypt, CN=R3",
          name_value: "api.example.com",
          not_before: "2024-01-01T00:00:00",
          not_after: "2024-04-01T00:00:00",
          entry_timestamp: "2024-01-01T00:05:00",
          serial_number: "03ab",
        },
      ],
      DOMAIN,
    );

    expect(result.hostnames[0].evidence).toEqual({
      entryId: 987654321,
      issuerName: "C=US, O=Let's Encrypt, CN=R3",
      serialNumber: "03ab",
      notBefore: "2024-01-01T00:00:00.000Z",
      notAfter: "2024-04-01T00:00:00.000Z",
      loggedAt: "2024-01-01T00:05:00.000Z",
      rawName: "api.example.com",
    });
  });

  it("reports a field the source omitted as null, never as a placeholder", () => {
    const result = parseCrtShResponse([{ name_value: "api.example.com" }], DOMAIN);
    expect(result.hostnames[0].evidence).toEqual({
      entryId: null,
      issuerName: null,
      serialNumber: null,
      notBefore: null,
      notAfter: null,
      loggedAt: null,
      rawName: "api.example.com",
    });
  });

  it("keeps the newest certificate's evidence for a name issued many times", () => {
    const result = parseCrtShResponse(
      [
        row({ id: 1, name_value: "api.example.com", not_after: "2019-01-01T00:00:00", serial_number: "old" }),
        row({ id: 2, name_value: "api.example.com", not_after: "2026-01-01T00:00:00", serial_number: "new" }),
        row({ id: 3, name_value: "api.example.com", not_after: "2022-01-01T00:00:00", serial_number: "middle" }),
      ],
      DOMAIN,
    );
    expect(result.hostnames).toHaveLength(1);
    expect(result.hostnames[0].evidence.serialNumber).toBe("new");
  });

  it("does not let an entry with no stated notAfter displace one that has it", () => {
    const result = parseCrtShResponse(
      [
        row({ name_value: "api.example.com", not_after: "2026-01-01T00:00:00", serial_number: "dated" }),
        row({ name_value: "api.example.com", serial_number: "undated" }),
      ],
      DOMAIN,
    );
    expect(result.hostnames[0].evidence.serialNumber).toBe("dated");
  });

  it("says so when it truncates, rather than quietly shrinking the estate", () => {
    const names = Array.from({ length: MAX_DISCOVERED_HOSTNAMES_PER_RUN + 25 }, (_, i) => `h${i}.example.com`);
    const result = parseCrtShResponse([row({ name_value: names.join("\n") })], DOMAIN);

    expect(result.hostnames).toHaveLength(MAX_DISCOVERED_HOSTNAMES_PER_RUN);
    expect(result.truncated).toBe(true);
    // The count of what was *read* is not truncated — that is the number that
    // stops the accepted list being mistaken for the whole answer.
    expect(result.namesRead).toBe(MAX_DISCOVERED_HOSTNAMES_PER_RUN + 25);
  });

  it("returns nothing at all rather than matching against a domain that is not one", () => {
    // Matching a SAN list against `*.example.com`, `Example.COM` or `` would
    // either match nothing or match by accident. Empty is the honest answer.
    for (const bad of ["", "*.example.com", "Example.COM", "example.com.", "localhost"]) {
      const result = parseCrtShResponse([row({ name_value: "www.example.com" })], bad);
      expect(result.hostnames).toEqual([]);
      expect(result.entriesRead).toBe(0);
    }
  });

  it("survives a response that is not the shape it expects", () => {
    for (const junk of [null, undefined, {}, "[]", 42, [null, 7, "x"]]) {
      expect(() => parseCrtShResponse(junk, DOMAIN)).not.toThrow();
      expect(parseCrtShResponse(junk, DOMAIN).hostnames).toEqual([]);
    }
  });
});

describe("certificateExpired", () => {
  const asOf = new Date("2026-08-15T00:00:00Z");

  it("distinguishes expired, current, and cannot-tell", () => {
    expect(certificateExpired({ notAfter: "2019-01-01T00:00:00.000Z" } as never, asOf)).toBe(true);
    expect(certificateExpired({ notAfter: "2027-01-01T00:00:00.000Z" } as never, asOf)).toBe(false);
    // Null is "the log stated no validity window", which is not "not expired".
    expect(certificateExpired({ notAfter: null } as never, asOf)).toBeNull();
  });
});

describe("the caveat", () => {
  it("states what the evidence supports and denies the three claims it does not", () => {
    expect(DISCOVERY_EVIDENCE_CAVEAT).toContain("certificate-transparency log");
    expect(DISCOVERY_EVIDENCE_CAVEAT).toContain("not a statement that this organisation owns or operates");
    expect(DISCOVERY_EVIDENCE_CAVEAT).toContain("unverified");
  });
});
