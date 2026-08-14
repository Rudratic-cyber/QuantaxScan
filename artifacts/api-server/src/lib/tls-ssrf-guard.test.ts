import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBlockedAddress,
  resolveAndValidateTarget,
  TargetRejectedError,
  TLS_PROBE_ESCAPE_HATCH_ENV_VAR,
} from "./tls-ssrf-guard";

/**
 * B3's SSRF guard. `github-url.ts`'s S7 writeup found its route was NOT
 * actually SSRF-capable — the host was always a fixed GitHub host. This route
 * is: the host is exactly what a caller names, so these tests are the real
 * thing, not a defence-in-depth extra.
 */
describe("isBlockedAddress — IPv4", () => {
  const blocked = [
    ["10.0.0.1", "RFC 1918 /8"],
    ["10.255.255.255", "RFC 1918 /8, top of range"],
    ["172.16.0.1", "RFC 1918 /12"],
    ["172.31.255.254", "RFC 1918 /12, top of range"],
    ["192.168.1.1", "RFC 1918 /16"],
    ["127.0.0.1", "loopback"],
    ["127.53.0.1", "loopback, non-canonical"],
    ["169.254.169.254", "the cloud metadata service"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "CGNAT shared address space"],
    ["0.0.0.0", "this network"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["192.0.2.1", "documentation TEST-NET-1"],
  ] as const;

  for (const [ip, label] of blocked) {
    it(`refuses ${ip} (${label})`, () => {
      expect(isBlockedAddress(ip)).not.toBeNull();
    });
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1"];
  for (const ip of allowed) {
    it(`allows ${ip} — a genuine public address`, () => {
      expect(isBlockedAddress(ip)).toBeNull();
    });
  }
});

describe("isBlockedAddress — IPv6", () => {
  const blocked = [
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fc00::1", "unique local"],
    ["fd12:3456:789a::1", "unique local, fd form"],
    ["ff02::1", "multicast"],
    // IPv4-mapped forms of blocked IPv4 addresses must not slip past the
    // IPv4 check just because they are spelled as IPv6.
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata service"],
    ["::ffff:10.0.0.1", "IPv4-mapped RFC 1918"],
    ["64:ff9b::169.254.169.254", "NAT64-mapped metadata service"],
  ] as const;

  for (const [ip, label] of blocked) {
    it(`refuses ${ip} (${label})`, () => {
      expect(isBlockedAddress(ip)).not.toBeNull();
    });
  }

  it("allows a genuine public IPv6 address", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBeNull();
  });

  it("allows an IPv4-mapped genuinely public address", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBeNull();
  });
});

describe("isBlockedAddress — non-IP input", () => {
  it("refuses a bare hostname (this function only ever sees literals from resolveAndValidateTarget)", () => {
    expect(isBlockedAddress("example.com")).not.toBeNull();
  });
});

describe("resolveAndValidateTarget", () => {
  it("accepts an IPv4 literal that is not blocked, without touching DNS", async () => {
    const resolved = await resolveAndValidateTarget("93.184.216.34", 443);
    expect(resolved).toEqual({ address: "93.184.216.34", host: "93.184.216.34", port: 443 });
  });

  it("rejects a loopback literal directly, with no DNS lookup involved", async () => {
    await expect(resolveAndValidateTarget("127.0.0.1", 443)).rejects.toThrow(TargetRejectedError);
  });

  it("rejects the metadata-service literal directly", async () => {
    const err = await resolveAndValidateTarget("169.254.169.254", 80).catch((e) => e);
    expect(err).toBeInstanceOf(TargetRejectedError);
    expect((err as InstanceType<typeof TargetRejectedError>).reason).toBe("blocked-address");
  });

  it("rejects a syntactically invalid hostname before any DNS lookup", async () => {
    const err = await resolveAndValidateTarget("not a hostname!!", 443).catch((e) => e);
    expect(err).toBeInstanceOf(TargetRejectedError);
    expect((err as InstanceType<typeof TargetRejectedError>).reason).toBe("invalid-hostname");
  });

  it("does not leak which blocked range was hit in the error's public shape — the message is for the server log only", async () => {
    // TargetRejectedError.message is written to logger.warn (server-side)
    // by callers; the route layer must translate this to a generic refusal,
    // mirroring parseGithubUrl's bare `null`. This test documents that
    // `reason` is a closed enum precisely so a route can switch on it
    // without ever forwarding `.message` to the HTTP response.
    const err = await resolveAndValidateTarget("10.0.0.1", 443).catch((e) => e);
    expect((err as InstanceType<typeof TargetRejectedError>).reason).toBe("blocked-address");
  });
});

describe("the escape hatch", () => {
  afterEach(() => {
    delete process.env[TLS_PROBE_ESCAPE_HATCH_ENV_VAR];
    vi.resetModules();
  });

  it("is off by default — unset means blocked", () => {
    expect(process.env[TLS_PROBE_ESCAPE_HATCH_ENV_VAR]).toBeUndefined();
    expect(isBlockedAddress("127.0.0.1")).not.toBeNull();
  });

  it("when explicitly set, widens the range check but the module must be re-imported to observe it (env is read at call time here, not cached)", async () => {
    process.env[TLS_PROBE_ESCAPE_HATCH_ENV_VAR] = "1";
    vi.resetModules();
    const reimported = await import("./tls-ssrf-guard");
    expect(reimported.isBlockedAddress("127.0.0.1")).toBeNull();
  });

  it("an arbitrary truthy-looking value other than the exact string '1' does not enable it — fail closed on a typo", async () => {
    process.env[TLS_PROBE_ESCAPE_HATCH_ENV_VAR] = "true";
    vi.resetModules();
    const reimported = await import("./tls-ssrf-guard");
    expect(reimported.isBlockedAddress("127.0.0.1")).not.toBeNull();
  });
});
