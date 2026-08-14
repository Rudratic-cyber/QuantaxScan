import { logger } from "./logger";

/**
 * Host and path validation for the GitHub scanning routes — S7.
 *
 * ## What was actually broken
 *
 * `parseGithubUrl()` used to accept any URL whose hostname *contained* the
 * substring `github.com`. That is not a hostname check. Verified against the
 * old implementation on Node 24 (the table below is reproduced by
 * `github-url.test.ts`, which runs the same inputs through the new one):
 *
 * | input                                          | old result   |
 * |------------------------------------------------|--------------|
 * | `https://github.com.evil.example/owner/repo`    | **accepted** |
 * | `https://evil-github.com/owner/repo`            | **accepted** |
 * | `https://169.254.169.254.github.com/owner/repo` | **accepted** |
 * | `http://github.com/owner/repo`                  | **accepted** |
 * | `https://user:pass@github.com/owner/repo`       | **accepted** |
 * | `https://github.com/../../etc/passwd`           | **accepted** as owner `etc`, repo `passwd` |
 * | `https://github.com/o/r%2F..%2F..`              | **accepted** as repo `r%2F..%2F..` |
 *
 * Two claims in the S7 write-up did **not** reproduce, and are corrected here
 * rather than repeated: `https://evil.example/?x=github.com` was already
 * rejected (`u.hostname` excludes the query string) and so was
 * `https://github.com@evil.example/owner/repo` (the hostname there is
 * `evil.example`).
 *
 * ## What the reachable surface was
 *
 * The caller's *host* never reached `fetch()`: every request is built against
 * a hardcoded `https://api.github.com/...` or
 * `https://raw.githubusercontent.com/...`. So this was **not** a
 * request-forgery primitive against internal networks or cloud metadata — the
 * reachable half was **path injection into two fixed hosts** via the `owner`
 * and `repo` segments, which are interpolated into those URLs unencoded. That
 * distinction is why "block private/link-local IP ranges" from the register's
 * remedy is *moot by construction* once the host is an exact allowlist: no
 * caller-controlled host reaches `fetch` at all, so there is no address to
 * resolve and check.
 *
 * ## Controls here
 *
 * 1. Exact hostname match against {@link ALLOWED_REPO_HOSTS}, not `includes`.
 * 2. `https:` only, no embedded credentials, no explicit port.
 * 3. `owner` and `repo` matched against GitHub's real charsets, which rejects
 *    `.`, `..` and anything percent-encoded, then encoded on the way into
 *    every request URL.
 * 4. {@link githubFetch} follows redirects manually, re-validating each hop
 *    against {@link ALLOWED_FETCH_HOSTS}, and applies a request timeout.
 *
 * See docs/Claude/08-security.md (S7).
 */

/** Hosts a caller may name in `repoUrl`. Compared with `===`, never `includes`. */
export const ALLOWED_REPO_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "www.github.com",
]);

/**
 * Hosts this server will issue a request to, including after a redirect.
 *
 * `api.github.com` serves the tree; `raw.githubusercontent.com` serves file
 * bodies. Nothing else is reachable — a redirect anywhere off this list is
 * refused rather than followed.
 */
export const ALLOWED_FETCH_HOSTS: ReadonlySet<string> = new Set([
  "api.github.com",
  "raw.githubusercontent.com",
]);

/**
 * GitHub logins: 1–39 characters of alphanumerics and hyphens. Notably no `.`,
 * which is what makes `.` and `..` unrepresentable, and no `%`, which is what
 * makes `%2F` path-escape unrepresentable.
 */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * Repository names additionally allow `.` and `_`, so `.`/`..` have to be
 * rejected explicitly below rather than falling out of the charset.
 */
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Redirect hops followed before giving up. GitHub uses at most one here. */
const MAX_REDIRECTS = 3;

/** Per-request ceiling. `fetchWithRetry` may still retry, so this is per attempt. */
export const GITHUB_FETCH_TIMEOUT_MS = 15_000;

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

/**
 * Parses a caller-supplied repository URL, or returns `null`.
 *
 * Deliberately returns a bare `null` for every rejection reason: the route
 * turns that into one generic 400, so a caller cannot use the error text to
 * map which hosts or shapes the server considers interesting.
 */
export function parseGithubUrl(url: string): GithubRepoRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  // `https:` only. `http:` was accepted before, and so was every other scheme
  // whose host happened to contain the substring — `file:` was excluded only
  // by accident, because its hostname is empty.
  if (u.protocol !== "https:") return null;

  // Credentials in the URL would be forwarded to GitHub on every request and
  // logged; there is no legitimate reason for a public repo URL to carry them.
  if (u.username !== "" || u.password !== "") return null;

  // An explicit port cannot change the destination (the host is not used to
  // build the request) but it is a reliable signal of a crafted URL.
  if (u.port !== "") return null;

  // The fix: exact match. `u.hostname` is already lowercased and
  // punycode-normalised by the URL parser.
  if (!ALLOWED_REPO_HOSTS.has(u.hostname)) return null;

  const segments = u.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");

  if (!OWNER_PATTERN.test(owner)) return null;
  if (!REPO_PATTERN.test(repo)) return null;
  // `.` and `..` satisfy REPO_PATTERN and would traverse the API path.
  if (repo === "." || repo === "..") return null;

  return { owner, repo };
}

/**
 * Encodes a repository-relative file path for interpolation into a raw URL.
 *
 * The path comes from GitHub's own tree response rather than the caller, but
 * it is still remote input being spliced into a URL, and a `..` segment would
 * climb out of the repository. Returns `null` if any segment is empty, `.` or
 * `..`.
 */
export function encodeRepoFilePath(filePath: string): string | null {
  const segments = filePath.split("/");
  if (segments.length === 0) return null;

  const encoded: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    encoded.push(encodeURIComponent(segment));
  }
  return encoded.join("/");
}

/** True when `url` is an https URL on an allowlisted host. */
export function isAllowedFetchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_FETCH_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export class DisallowedRedirectError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super("Refused to follow a redirect off the GitHub allowlist");
    this.name = "DisallowedRedirectError";
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Removes `Authorization` when the hop crosses an origin, which is what
 * WHATWG Fetch's "CORS non-wildcard request-header name" rule does for
 * automatic redirects. Manual following opts out of that rule, so this puts it
 * back. Every other header is preserved, matching the spec.
 */
export function dropAuthorizationAcrossOrigins(
  headers: Record<string, string>,
  from: string,
  to: string,
): Record<string, string> {
  if (new URL(from).origin === new URL(to).origin) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"),
  );
}

/**
 * `fetch` restricted to {@link ALLOWED_FETCH_HOSTS}, with manual redirects.
 *
 * ### On the register's "redirect token leak"
 *
 * The register lists the `Authorization: Bearer ${GITHUB_TOKEN}` header
 * following a cross-host redirect as a risk. **It was already mitigated, and
 * not by this codebase.** WHATWG Fetch strips the `Authorization` header when
 * a redirect crosses origins, and undici implements it; measured on Node
 * v24.14.0 against two local servers, a 302 from `127.0.0.1:A` to
 * `127.0.0.1:B` arrived with `authorization` absent while other headers
 * survived, and a same-origin 302 kept it. `github-url.test.ts` asserts that
 * against the running runtime rather than trusting the claim.
 *
 * So what this function adds on the destination is **defence in depth**: it
 * stops the request being issued at all to a host GitHub redirects us to. That
 * is a small win — the first hop is already a fixed GitHub host — and it is
 * stated that way rather than claimed as the fix for the register's item.
 *
 * On the token it adds something less optional. Following redirects manually
 * means undici's stripping no longer applies: *we* choose the headers for hop
 * two, so re-sending `options.headers` verbatim would reintroduce exactly the
 * leak undici was preventing. {@link dropAuthorizationAcrossOrigins} therefore
 * reimplements that rule, and the test asserts it directly.
 *
 * Redirects are followed manually rather than with `redirect: "error"`:
 * `api.github.com` legitimately 301s a renamed repository, and refusing that
 * would break real scans. Verified that undici exposes `Location` under
 * `redirect: "manual"` (it returns a normal response with the header, not a
 * browser-style opaque one), which is what makes the hop-by-hop check
 * possible.
 */
export async function githubFetch(
  url: string,
  options: Omit<RequestInit, "headers" | "redirect" | "signal"> & {
    headers?: Record<string, string>;
  } = {},
  timeoutMs: number = GITHUB_FETCH_TIMEOUT_MS,
): Promise<Response> {
  if (!isAllowedFetchUrl(url)) {
    throw new DisallowedRedirectError(url, url);
  }

  const { headers: initialHeaders, ...rest } = options;
  let current = url;
  let headers: Record<string, string> = initialHeaders ?? {};

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      ...rest,
      headers,
      redirect: "manual",
      // Per attempt, not per call: `fetchWithRetry` layers its own retries on
      // top, and each redirect hop is a fresh request.
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = res.headers.get("location");
    if (!location) return res;

    const next = new URL(location, current).toString();
    if (!isAllowedFetchUrl(next)) {
      logger.warn({ from: current, to: next }, "Refused a GitHub redirect off the allowlist");
      throw new DisallowedRedirectError(current, next);
    }
    headers = dropAuthorizationAcrossOrigins(headers, current, next);
    current = next;
  }

  throw new Error("Too many redirects from GitHub");
}
