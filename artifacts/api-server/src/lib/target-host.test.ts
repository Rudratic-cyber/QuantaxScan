import { describe, it, expect } from "vitest";
import { normaliseTargetHost, targetHostRejection } from "./target-host";

/**
 * G-23. The rule these assertions protect is not "reject bad input" — it is
 * that a target we could never dial must be refused at the boundary, where the
 * caller can still fix it, rather than stored and failed forever.
 */
describe("normaliseTargetHost", () => {
  it("accepts a hostname and canonicalises it, so one host is one target", () => {
    expect(normaliseTargetHost("example.test")).toBe("example.test");
    // DNS is case-insensitive and a trailing root dot is legal; both must
    // resolve to the same stored value or a re-registration mints a duplicate
    // schedule against the same host.
    expect(normaliseTargetHost("EXAMPLE.test")).toBe("example.test");
    expect(normaliseTargetHost("example.test.")).toBe("example.test");
    expect(normaliseTargetHost("  example.test  ")).toBe("example.test");
    expect(normaliseTargetHost("a.deeply.nested.example.test")).toBe("a.deeply.nested.example.test");
  });

  it("accepts an IP literal, which the hostname rule alone refuses", () => {
    // `normaliseHostname` rejects these on purpose — discovery discovers
    // *names*. A collection target may legitimately be an address, which is the
    // only thing this module adds on top.
    expect(normaliseTargetHost("192.0.2.10")).toBe("192.0.2.10");
    expect(normaliseTargetHost("2001:db8::1")).toBe("2001:db8::1");
    // Bracketed IPv6 is how it is written beside a port; stored unbracketed so
    // the two forms are one target.
    expect(normaliseTargetHost("[2001:db8::1]")).toBe("2001:db8::1");
  });

  it("refuses a URL — the case G-23 was opened for", () => {
    expect(normaliseTargetHost("https://example.test/path")).toBeNull();
    expect(normaliseTargetHost("http://example.test")).toBeNull();
    expect(normaliseTargetHost("example.test/path")).toBeNull();
    expect(normaliseTargetHost("user:pass@example.test")).toBeNull();
  });

  it("refuses everything else that could never be dialled", () => {
    expect(normaliseTargetHost("")).toBeNull();
    expect(normaliseTargetHost("   ")).toBeNull();
    expect(normaliseTargetHost("*.example.test")).toBeNull();
    // A single label is not resolvable outside a private search domain, and a
    // schedule that silently depended on the server's resolver configuration
    // would behave differently in every deployment.
    expect(normaliseTargetHost("localhost")).toBeNull();
    expect(normaliseTargetHost("example.test:443")).toBeNull();
    expect(normaliseTargetHost("exa mple.test")).toBeNull();
    expect(normaliseTargetHost("-example.test")).toBeNull();
    expect(normaliseTargetHost(`${"a".repeat(64)}.test`)).toBeNull();
  });

  it("does not repair a name into something plausible", () => {
    // The tempting behaviour is to strip the path and keep the host. It is
    // wrong: the caller told us something specific and we would be acting on a
    // different thing than they asked for, without saying so.
    expect(normaliseTargetHost("https://example.test/path")).not.toBe("example.test");
  });
});

describe("targetHostRejection", () => {
  it("names what was wrong with the caller's input rather than restating the rule", () => {
    expect(targetHostRejection("https://example.test/x")).toMatch(/is a URL/);
    expect(targetHostRejection("example.test/x")).toMatch(/contains a path/);
    expect(targetHostRejection("*.example.test")).toMatch(/wildcard/);
    expect(targetHostRejection("example.test:443")).toMatch(/port/);
    expect(targetHostRejection("!!!")).toMatch(/not a hostname or IP address/);
  });

  it("quotes the input back, so a caller with many targets knows which one", () => {
    expect(targetHostRejection("https://a.test/x")).toContain("https://a.test/x");
  });
});
