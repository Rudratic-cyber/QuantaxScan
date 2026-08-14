import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import {
  parseGithubUrl,
  encodeRepoFilePath,
  isAllowedFetchUrl,
  githubFetch,
  dropAuthorizationAcrossOrigins,
  DisallowedRedirectError,
} from "./github-url";

/**
 * S7. The point of this file is the *bypasses*, not the happy path: a test
 * that only proves `https://github.com/owner/repo` works proves nothing about
 * `https://github.com.evil.example/owner/repo`.
 *
 * `oldParseGithubUrl` below is the exact implementation that shipped, kept so
 * the table is a demonstration rather than a claim — each case asserts that
 * the old one accepted the input and the new one rejects it. If someone
 * reverts the fix, the "old accepted this" half stays green and the "new
 * rejects it" half fails, which is the right way round.
 */
function oldParseGithubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("github.com")) return null;
    const parts = u.pathname.replace(/^\//, "").split("/");
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

describe("parseGithubUrl — inputs the substring check used to accept", () => {
  const bypasses: Array<[string, string]> = [
    ["a suffix domain the attacker owns", "https://github.com.evil.example/owner/repo"],
    ["a prefix domain the attacker owns", "https://evil-github.com/owner/repo"],
    ["an IP literal dressed as a subdomain", "https://169.254.169.254.github.com/owner/repo"],
    ["a deeper subdomain the attacker owns", "https://github.com.attacker.test/owner/repo"],
    ["plaintext http", "http://github.com/owner/repo"],
    ["credentials embedded in the URL", "https://user:pass@github.com/owner/repo"],
    ["an explicit port", "https://github.com:8443/owner/repo"],
    ["a percent-encoded slash in the repo name", "https://github.com/owner/repo%2F..%2F.."],
    ["a percent-encoded traversal in the repo name", "https://github.com/owner/repo%2e%2e%2f%2e%2e"],
  ];

  for (const [what, url] of bypasses) {
    it(`rejects ${what}: ${url}`, () => {
      expect(oldParseGithubUrl(url), "the old implementation accepted this").not.toBeNull();
      expect(parseGithubUrl(url)).toBeNull();
    });
  }

  /**
   * Two shapes the S7 write-up named as bypasses did **not** reproduce. They
   * are asserted rather than repeated: `u.hostname` excludes the query string,
   * and the host in a userinfo-bearing URL is what follows the `@`.
   */
  it("was already rejecting the two shapes the register got wrong", () => {
    for (const url of [
      "https://evil.example/?x=github.com",
      "https://github.com@evil.example/owner/repo",
    ]) {
      expect(oldParseGithubUrl(url), `${url} was already rejected before the fix`).toBeNull();
      expect(parseGithubUrl(url)).toBeNull();
    }
  });

  it("rejects non-http schemes and malformed input", () => {
    for (const url of ["file:///etc/passwd", "gopher://github.com/owner/repo", "not a url", "", "https://github.com/onlyowner"]) {
      expect(parseGithubUrl(url)).toBeNull();
    }
  });

  it("still accepts the real thing", () => {
    expect(parseGithubUrl("https://github.com/paramiko/paramiko")).toEqual({ owner: "paramiko", repo: "paramiko" });
    expect(parseGithubUrl("https://www.github.com/paramiko/paramiko")).toEqual({ owner: "paramiko", repo: "paramiko" });
    expect(parseGithubUrl("https://github.com/paramiko/paramiko.git")).toEqual({ owner: "paramiko", repo: "paramiko" });
    expect(parseGithubUrl("https://github.com/paramiko/paramiko/tree/main/demos")).toEqual({ owner: "paramiko", repo: "paramiko" });
    expect(parseGithubUrl("https://GitHub.com/Micro-Soft/dot.net_core-1")).toEqual({ owner: "Micro-Soft", repo: "dot.net_core-1" });
  });

  it("rejects `.` and `..` as a whole repo segment, which the charset alone allows", () => {
    expect(parseGithubUrl("https://github.com/owner/.")).toBeNull();
    expect(parseGithubUrl("https://github.com/owner/..")).toBeNull();
  });

  /**
   * Not a bypass, and worth recording as one that was investigated and found
   * benign: `new URL` resolves dot-segments before `pathname` is ever read, so
   * `../../etc/passwd` arrives as the ordinary path `/etc/passwd`. It becomes
   * owner `etc`, repo `passwd` — a request for a repository that does not
   * exist, not a traversal — and both halves are still charset-checked.
   */
  it("sees dot-segments already resolved by the URL parser", () => {
    expect(parseGithubUrl("https://github.com/../../etc/passwd")).toEqual({ owner: "etc", repo: "passwd" });
  });
});

describe("encodeRepoFilePath — the tree is remote input too", () => {
  it("encodes each segment without encoding the separators", () => {
    expect(encodeRepoFilePath("src/lib/my file.py")).toBe("src/lib/my%20file.py");
    expect(encodeRepoFilePath("a/b#c?d.ts")).toBe("a/b%23c%3Fd.ts");
  });

  it("refuses a path that could climb out of the repository", () => {
    expect(encodeRepoFilePath("../../../etc/passwd")).toBeNull();
    expect(encodeRepoFilePath("src/./x.py")).toBeNull();
    expect(encodeRepoFilePath("src//x.py")).toBeNull();
    expect(encodeRepoFilePath("")).toBeNull();
  });
});

describe("isAllowedFetchUrl", () => {
  it("allows only the two GitHub hosts, over https", () => {
    expect(isAllowedFetchUrl("https://api.github.com/rate_limit")).toBe(true);
    expect(isAllowedFetchUrl("https://raw.githubusercontent.com/o/r/main/a.py")).toBe(true);
    expect(isAllowedFetchUrl("http://api.github.com/rate_limit")).toBe(false);
    expect(isAllowedFetchUrl("https://api.github.com.evil.example/rate_limit")).toBe(false);
    expect(isAllowedFetchUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedFetchUrl("http://127.0.0.1:8080/")).toBe(false);
  });
});

describe("githubFetch", () => {
  it("refuses to issue a request to a host off the allowlist", async () => {
    await expect(githubFetch("http://127.0.0.1:1/")).rejects.toBeInstanceOf(DisallowedRedirectError);
    await expect(githubFetch("https://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      DisallowedRedirectError,
    );
  });
});

describe("dropAuthorizationAcrossOrigins", () => {
  it("keeps every header when the origin is unchanged", () => {
    const headers = { Authorization: "Bearer t", Accept: "application/json" };
    expect(
      dropAuthorizationAcrossOrigins(headers, "https://api.github.com/a", "https://api.github.com/b"),
    ).toEqual(headers);
  });

  it("drops only Authorization when the origin changes", () => {
    expect(
      dropAuthorizationAcrossOrigins(
        { Authorization: "Bearer t", Accept: "application/json" },
        "https://api.github.com/a",
        "https://raw.githubusercontent.com/b",
      ),
    ).toEqual({ Accept: "application/json" });
  });

  it("matches header names case-insensitively", () => {
    expect(
      dropAuthorizationAcrossOrigins({ authorization: "Bearer t" }, "https://a.test/", "https://b.test/"),
    ).toEqual({});
  });
});

/**
 * The register lists "the Authorization header following a cross-host redirect"
 * as an open risk. It is already mitigated by the runtime, not by this
 * codebase: WHATWG Fetch deletes `Authorization` on a cross-origin redirect and
 * undici implements it. That is a claim about the Node we happen to run on, so
 * it is measured rather than asserted from the spec — if a future runtime
 * regresses it, this fails and `githubFetch`'s own stripping becomes the only
 * control rather than a second one.
 */
describe("the runtime's own cross-origin redirect behaviour", () => {
  async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  it("strips Authorization across an origin change and keeps it within one", async () => {
    const echo = createServer((req, res) => {
      res.end(JSON.stringify(req.headers));
    });
    const echoPort = await listen(echo);

    const redirector = createServer((req, res) => {
      const target =
        req.url === "/cross" ? `http://127.0.0.1:${echoPort}/echo` : "/echo";
      if (req.url === "/echo") {
        res.end(JSON.stringify(req.headers));
        return;
      }
      res.writeHead(302, { Location: target });
      res.end();
    });
    const redirectorPort = await listen(redirector);

    try {
      const crossOrigin = await fetch(`http://127.0.0.1:${redirectorPort}/cross`, {
        headers: { Authorization: "Bearer SECRET", "X-Marker": "kept" },
      });
      const crossHeaders = (await crossOrigin.json()) as Record<string, string>;
      expect(crossHeaders["authorization"]).toBeUndefined();
      expect(crossHeaders["x-marker"]).toBe("kept");

      const sameOrigin = await fetch(`http://127.0.0.1:${redirectorPort}/same`, {
        headers: { Authorization: "Bearer SECRET" },
      });
      const sameHeaders = (await sameOrigin.json()) as Record<string, string>;
      expect(sameHeaders["authorization"]).toBe("Bearer SECRET");
    } finally {
      echo.close();
      redirector.close();
    }
  });

  it("exposes Location under redirect: manual, which is what lets githubFetch check each hop", async () => {
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { Location: "https://evil.example/next" });
      res.end();
    });
    const port = await listen(redirector);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/start`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://evil.example/next");
    } finally {
      redirector.close();
    }
  });
});
