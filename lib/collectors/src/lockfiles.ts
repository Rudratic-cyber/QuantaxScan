/**
 * Lockfile/manifest parsing for B2 (docs/Claude/03-features.md, row B2).
 *
 * These parsers answer exactly one question — *which package names and
 * versions does this file pin?* — and deliberately nothing else. That is why
 * they are hand-written line/JSON readers rather than a YAML dependency:
 * `@workspace/collectors` is kept dependency-free apart from `zod` so it can
 * ship as a standalone on-prem agent (AGENTS.md §"Package boundaries"), and a
 * full YAML/TOML parser would be a large amount of new attack surface for a
 * name-and-version extraction. The cost of that trade is that these readers
 * are format-specific and tolerant: anything they do not recognise is skipped
 * rather than guessed at, so an unparsed section produces *fewer*
 * observations, never wrong ones.
 *
 * A package that appears with no determinable version yields
 * `version: undefined`, not `"unknown"` or `"latest"` — see
 * docs/Claude/09-open-gaps.md G-05: a wrong value is worse than null.
 */

export const LOCKFILE_KINDS = ["pnpm-lock", "npm-lock", "yarn-lock", "pip-requirements"] as const;
export type LockfileKind = (typeof LOCKFILE_KINDS)[number];

/** Package ecosystem, in purl (`pkg:<type>/...`) spelling. */
export type Ecosystem = "npm" | "pypi";

export interface LockedPackage {
  /** As written in the lockfile (npm: `@scope/name`; PyPI: whatever case the file used). */
  name: string;
  /** Exact pinned version, or `undefined` when the file does not pin one (e.g. `requirements.txt` with `>=`). */
  version?: string;
}

const ECOSYSTEM_BY_KIND: Record<LockfileKind, Ecosystem> = {
  "pnpm-lock": "npm",
  "npm-lock": "npm",
  "yarn-lock": "npm",
  "pip-requirements": "pypi",
};

export function ecosystemForLockfile(kind: LockfileKind): Ecosystem {
  return ECOSYSTEM_BY_KIND[kind];
}

/**
 * Which lockfile, if any, a submitted file path is. Matched on the basename,
 * so a lockfile nested in a monorepo package (`apps/web/pnpm-lock.yaml`) is
 * recognised. `requirements-dev.txt` / `requirements/base.txt` style names are
 * accepted too — they are the same format and commonly hold the real pins.
 */
export function detectLockfileKind(path: string): LockfileKind | undefined {
  const basename = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (basename === "pnpm-lock.yaml" || basename === "pnpm-lock.yml") return "pnpm-lock";
  if (basename === "package-lock.json" || basename === "npm-shrinkwrap.json") return "npm-lock";
  if (basename === "yarn.lock") return "yarn-lock";
  if (/^requirements([-_.][\w.-]+)?\.txt$/.test(basename)) return "pip-requirements";
  return undefined;
}

export function parseLockfile(kind: LockfileKind, content: string): LockedPackage[] {
  switch (kind) {
    case "pnpm-lock":
      return parsePnpmLock(content);
    case "npm-lock":
      return parseNpmLock(content);
    case "yarn-lock":
      return parseYarnLock(content);
    case "pip-requirements":
      return parsePipRequirements(content);
  }
}

/**
 * `pnpm-lock.yaml`. Only the top-level `packages:` and `snapshots:` maps are
 * read; their two-space-indented keys are the package identifiers, in one of
 * three shapes across lockfile versions:
 *   v9  `name@1.2.3:`           (and quoted, `'@scope/name@1.2.3':`)
 *   v6  `/name@1.2.3:`
 *   v5  `/name/1.2.3:` / `/@scope/name/1.2.3:`
 * A key may carry a peer-dependency suffix — `pkg@1.0.0(react@19.1.0)` — which
 * is part of pnpm's resolution identity, not of the package version, so it is
 * cut off before the name/version split.
 */
function parsePnpmLock(content: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let inPackageMap = false;
  for (const line of content.split("\n")) {
    if (/^\S/.test(line)) {
      // A new top-level key ends whichever section we were in.
      inPackageMap = /^(packages|snapshots):\s*$/.test(line);
      continue;
    }
    if (!inPackageMap) continue;
    // Exactly two spaces — the `(?! )` matters: a `peerDependencies:` entry is
    // indented six, and without the guard the leading spaces get swallowed by
    // the key capture and `'@types/react':` parses as a package.
    const keyMatch = line.match(/^ {2}(?! )'?(.+?)'?:\s*$/);
    if (!keyMatch) continue; // deeper-indented content (resolution:, engines:, peerDependencies, ...) or a blank line
    const parsed = parsePnpmPackageKey(keyMatch[1]);
    if (parsed) out.push(parsed);
  }
  return dedupe(out);
}

function parsePnpmPackageKey(key: string): LockedPackage | undefined {
  const base = key.split("(")[0].trim();
  const hadLeadingSlash = base.startsWith("/");
  const spec = hadLeadingSlash ? base.slice(1) : base;
  const at = spec.lastIndexOf("@");
  if (at > 0) {
    const version = spec.slice(at + 1);
    return { name: spec.slice(0, at), version: version || undefined };
  }
  if (hadLeadingSlash) {
    // v5 `/@scope/name/1.2.3` — the version is the last path segment.
    const slash = spec.lastIndexOf("/");
    if (slash > 0) return { name: spec.slice(0, slash), version: spec.slice(slash + 1) || undefined };
  }
  return undefined;
}

interface NpmLockEntry {
  version?: string;
  dependencies?: Record<string, NpmLockEntry>;
}

/**
 * `package-lock.json` / `npm-shrinkwrap.json`. Lockfile v2/v3 key their
 * `packages` map by install path — `node_modules/a/node_modules/b` is package
 * `b`, so the name is whatever follows the *last* `node_modules/`. The `""`
 * root entry and workspace-link entries have no `node_modules/` segment and
 * are skipped. v1 (and v2's retained legacy tree) is the recursive
 * `dependencies` object instead.
 */
function parseNpmLock(content: string): LockedPackage[] {
  let json: { packages?: Record<string, NpmLockEntry>; dependencies?: Record<string, NpmLockEntry> };
  try {
    json = JSON.parse(content);
  } catch {
    // A lockfile we cannot parse contributes no observations. Reporting a
    // guess from a half-read file would be worse than reporting nothing.
    return [];
  }
  const out: LockedPackage[] = [];

  for (const [path, entry] of Object.entries(json.packages ?? {})) {
    const marker = path.lastIndexOf("node_modules/");
    if (marker === -1) continue;
    const name = path.slice(marker + "node_modules/".length);
    if (name) out.push({ name, version: entry?.version });
  }

  const walk = (tree: Record<string, NpmLockEntry>) => {
    for (const [name, entry] of Object.entries(tree)) {
      out.push({ name, version: entry?.version });
      if (entry?.dependencies) walk(entry.dependencies);
    }
  };
  if (json.dependencies) walk(json.dependencies);

  return dedupe(out);
}

/**
 * `yarn.lock`, both dialects. v1 has unindented, comma-separated request
 * specs (`"pkg@^1.0.0", "pkg@~1.2":`) followed by `  version "1.2.3"`; berry
 * (v2+) is YAML with protocol-qualified specs (`"pkg@npm:^1.0.0":`) followed
 * by `  version: 1.2.3`. In both, the name is everything before the *last*
 * `@`, which is what keeps scoped packages intact.
 */
function parseYarnLock(content: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let pendingNames: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      pendingNames = [];
      const header = line.replace(/:\s*$/, "");
      for (const rawSpec of header.split(",")) {
        const spec = rawSpec.trim().replace(/^"(.*)"$/, "$1");
        if (!spec || spec === "__metadata") continue;
        const at = spec.lastIndexOf("@");
        if (at > 0) pendingNames.push(spec.slice(0, at));
      }
      continue;
    }
    if (pendingNames.length === 0) continue;
    const versionMatch = line.match(/^\s+version:?\s+"?([^"\s]+)"?\s*$/);
    if (versionMatch) {
      for (const name of pendingNames) out.push({ name, version: versionMatch[1] });
      pendingNames = [];
    }
  }
  return dedupe(out);
}

/**
 * `requirements.txt`. This is a *manifest*, not a lockfile: only `==` states
 * an exact version, so `cryptography>=41` yields `version: undefined` rather
 * than a fabricated one. Wildcard pins (`==1.2.*`) are ranges too and are
 * treated the same way. Option lines (`-r`, `-e`, `--hash=`), comments,
 * extras (`paramiko[gssapi]`) and environment markers (`; python_version<"3.9"`)
 * are handled; `poetry.lock`/`Pipfile.lock` are not read by this change.
 */
function parsePipRequirements(content: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const logicalLine of joinBackslashContinuations(content)) {
    const withoutComment = logicalLine.replace(/(^|\s)#.*$/, "$1").trim();
    if (!withoutComment || withoutComment.startsWith("-")) continue;
    const spec = withoutComment.split(";")[0].trim();
    const match = spec.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/);
    if (!match) continue;
    const rest = match[2].trim();
    const pinned = rest.match(/^==\s*([^\s,;]+)/);
    const version = pinned && !pinned[1].includes("*") ? pinned[1] : undefined;
    out.push({ name: match[1], version });
  }
  return dedupe(out);
}

function joinBackslashContinuations(content: string): string[] {
  const lines: string[] = [];
  let buffer = "";
  for (const line of content.split("\n")) {
    const trimmedEnd = line.replace(/\r$/, "");
    if (trimmedEnd.endsWith("\\")) {
      buffer += `${trimmedEnd.slice(0, -1)} `;
      continue;
    }
    lines.push(buffer + trimmedEnd);
    buffer = "";
  }
  if (buffer) lines.push(buffer);
  return lines;
}

/** Same name at the same version listed twice (v2 lockfiles carry both a `packages` map and the legacy tree) is one fact, not two. */
function dedupe(packages: LockedPackage[]): LockedPackage[] {
  const seen = new Set<string>();
  const out: LockedPackage[] = [];
  for (const pkg of packages) {
    const key = `${pkg.name} ${pkg.version ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pkg);
  }
  return out;
}

/**
 * Ecosystem-correct name normalisation for table lookups. PyPI names are
 * case-insensitive and treat runs of `-`, `_` and `.` as equivalent
 * (PEP 503); npm names are lowercase already but are folded defensively.
 */
export function normalisePackageName(ecosystem: Ecosystem, name: string): string {
  const lower = name.trim().toLowerCase();
  return ecosystem === "pypi" ? lower.replace(/[-_.]+/g, "-") : lower;
}

/**
 * Package URL (purl, https://github.com/package-url/purl-spec) for a package.
 * The npm scope is a purl *namespace*, so `@noble/ed25519` is
 * `pkg:npm/%40noble/ed25519` — the `@` must be percent-encoded or the purl
 * cannot be parsed back.
 */
export function purlFor(ecosystem: Ecosystem, name: string, version?: string): string {
  let path: string;
  if (ecosystem === "npm" && name.startsWith("@")) {
    const [scope, ...rest] = name.slice(1).split("/");
    path = `%40${encodeURIComponent(scope)}/${encodeURIComponent(rest.join("/"))}`;
  } else {
    path = encodeURIComponent(name);
  }
  return version ? `pkg:${ecosystem}/${path}@${encodeURIComponent(version)}` : `pkg:${ecosystem}/${path}`;
}
