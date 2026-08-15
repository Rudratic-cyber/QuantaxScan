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

export const LOCKFILE_KINDS = [
  "pnpm-lock",
  "npm-lock",
  "yarn-lock",
  "pip-requirements",
  // Java. `pom.xml` and `build.gradle*` are *manifests* (a version may be
  // BOM-managed or interpolated and therefore unknowable from the file);
  // `gradle.lockfile` is a real lock.
  "maven-pom",
  "gradle-lock",
  "gradle-build",
  // Go. `go.sum` is a superset of the build graph — it carries every module
  // version the module graph ever considered, not only the selected one — so
  // `go.mod` is the better evidence and both are read.
  "go-mod",
  "go-sum",
  // .NET. `packages.lock.json` is a real lock; `packages.config` and the
  // MSBuild project/props files are manifests.
  "nuget-lock",
  "nuget-packages-config",
  "dotnet-project",
  // Rust.
  "cargo-lock",
] as const;
export type LockfileKind = (typeof LOCKFILE_KINDS)[number];

/**
 * Package ecosystem, in purl (`pkg:<type>/...`) spelling — `golang` rather
 * than `go`, `maven` rather than `java`, because these strings are written
 * into `assets.location` and read back by the ingest path's LIKE-prefix
 * reconciliation. No value here may contain `%` or `_`
 * (`asset-ingest.ts`'s `reobservationPredicate` relies on that).
 */
export const ECOSYSTEM_VALUES = ["npm", "pypi", "maven", "golang", "nuget", "cargo"] as const;
export type Ecosystem = (typeof ECOSYSTEM_VALUES)[number];

export interface LockedPackage {
  /**
   * As written in the lockfile, with **one** exception per ecosystem where two
   * files in the same repository would otherwise spell the same dependency two
   * ways and mint two assets that both look real:
   *
   *  - npm `@scope/name`, PyPI and Maven `group:artifact`, Cargo: verbatim.
   *  - NuGet: folded to lower case. Package ids are case-insensitive and a
   *    `.csproj` and a `packages.lock.json` in one repository routinely
   *    disagree (`BouncyCastle.Cryptography` / `bouncycastle.cryptography`).
   *  - Go: `!x` escapes un-escaped back to upper case, because `go.sum` writes
   *    `github.com/!burnt!sushi/toml` where `go.mod` writes `BurntSushi`.
   *
   * The reason this is done in the parser and not in `purlFor()` is that
   * `location` (built from this name) feeds the dependency fingerprint
   * `repo + ecosystem + package + algorithm`. Two spellings there are two
   * assets, and nothing in the system would report an error.
   */
  name: string;
  /** Exact pinned version, or `undefined` when the file does not pin one (e.g. `requirements.txt` with `>=`, or a Maven version inherited from a BOM). */
  version?: string;
}

const ECOSYSTEM_BY_KIND: Record<LockfileKind, Ecosystem> = {
  "pnpm-lock": "npm",
  "npm-lock": "npm",
  "yarn-lock": "npm",
  "pip-requirements": "pypi",
  "maven-pom": "maven",
  "gradle-lock": "maven",
  "gradle-build": "maven",
  "go-mod": "golang",
  "go-sum": "golang",
  "nuget-lock": "nuget",
  "nuget-packages-config": "nuget",
  "dotnet-project": "nuget",
  "cargo-lock": "cargo",
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
  if (basename === "pom.xml") return "maven-pom";
  // Gradle writes `gradle.lockfile` for the project's own configurations and
  // `buildscript-gradle.lockfile` for the build classpath.
  if (basename === "gradle.lockfile" || basename === "buildscript-gradle.lockfile") return "gradle-lock";
  if (basename === "build.gradle" || basename === "build.gradle.kts") return "gradle-build";
  if (basename === "go.mod") return "go-mod";
  if (basename === "go.sum") return "go-sum";
  // Checked before the generic project files: `packages.lock.json` is a lock,
  // `packages.config` is the pre-PackageReference manifest.
  if (basename === "packages.lock.json") return "nuget-lock";
  if (basename === "packages.config") return "nuget-packages-config";
  // `Directory.Packages.props` is where central package management puts the
  // versions, so a repository using it has none in its `.csproj` files at all.
  if (/\.(cs|fs|vb)proj$/.test(basename)) return "dotnet-project";
  if (basename === "directory.packages.props" || basename === "directory.build.props") return "dotnet-project";
  if (basename === "cargo.lock") return "cargo-lock";
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
    case "maven-pom":
      return parseMavenPom(content);
    case "gradle-lock":
      return parseGradleLockfile(content);
    case "gradle-build":
      return parseGradleBuild(content);
    case "go-mod":
      return parseGoMod(content);
    case "go-sum":
      return parseGoSum(content);
    case "nuget-lock":
      return parseNugetLockfile(content);
    case "nuget-packages-config":
      return parsePackagesConfig(content);
    case "dotnet-project":
      return parseDotnetProject(content);
    case "cargo-lock":
      return parseCargoLock(content);
  }
}

/**
 * A version string that is a build-system variable reference is not a version.
 * `<version>${bc.version}</version>`, `Version="$(BouncyCastleVersion)"` and
 * Gradle's `"$bcVersion"` all resolve elsewhere — to a value this parser
 * cannot see — so they yield `undefined` rather than the literal placeholder
 * (docs/Claude/09-open-gaps.md G-05: a wrong value is worse than no value).
 */
function literalVersion(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("${") || trimmed.includes("$(") || trimmed.startsWith("$")) return undefined;
  // A Maven/NuGet version *range* (`[2.4.0,3.0.0)`, `1.0.+`, `1.*`) states a
  // constraint, not a pin — the same distinction `requirements.txt` makes
  // between `==` and `>=`. Deliberately narrow: Go's `v2.0.0+incompatible` and
  // semver build metadata are exact versions and must survive, so a trailing
  // `+` is a range and an embedded one is not.
  if (/^[[(]/.test(trimmed) || trimmed.includes(",") || trimmed.includes("*") || trimmed.endsWith("+")) return undefined;
  return trimmed;
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

/* ------------------------------------------------------------------ *
 * Java — Maven and Gradle
 * ------------------------------------------------------------------ */

/** Strip XML/HTML comments before any tag matching, so a commented-out dependency is not read as one. */
function stripXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

function firstTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : undefined;
}

/**
 * `pom.xml`. Three deliberate exclusions, each of which would otherwise report
 * something the project does not actually ship:
 *
 *  - `<dependencyManagement>` declares versions for dependencies a module
 *    *may* take, not ones it takes.
 *  - `<build>` (and therefore `<plugins>`) is build-time tooling.
 *  - `<parent>` is a POM reference, not a jar on the classpath.
 *
 * `<profiles>` is kept: a profile's dependencies are real. Version properties
 * declared in the POM's own `<properties>` block are resolved one level
 * (`${bc.version}`); anything still unresolved — `${project.version}`, a
 * property from a parent POM, or a version inherited from a BOM and therefore
 * absent altogether — yields `undefined`, never the placeholder text.
 */
function parseMavenPom(content: string): LockedPackage[] {
  const xml = stripXmlComments(content)
    .replace(/<dependencyManagement\b[^>]*>[\s\S]*?<\/dependencyManagement>/g, "")
    .replace(/<build\b[^>]*>[\s\S]*?<\/build>/g, "")
    .replace(/<reporting\b[^>]*>[\s\S]*?<\/reporting>/g, "")
    .replace(/<parent\b[^>]*>[\s\S]*?<\/parent>/g, "");

  const properties = new Map<string, string>();
  const propertiesBlock = xml.match(/<properties\b[^>]*>([\s\S]*?)<\/properties>/);
  if (propertiesBlock) {
    for (const entry of propertiesBlock[1].matchAll(/<([\w.-]+)\s*>([^<]*)<\/\1>/g)) {
      properties.set(entry[1], entry[2].trim());
    }
  }

  const out: LockedPackage[] = [];
  for (const match of xml.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g)) {
    const block = match[1];
    const groupId = firstTag(block, "groupId");
    const artifactId = firstTag(block, "artifactId");
    if (!groupId || !artifactId) continue;
    const rawVersion = firstTag(block, "version");
    const resolved = rawVersion?.replace(/^\$\{([\w.-]+)\}$/, (whole, key: string) => properties.get(key) ?? whole);
    out.push({ name: `${groupId}:${artifactId}`, version: literalVersion(resolved) });
  }
  return dedupe(out);
}

/**
 * `gradle.lockfile` — Gradle's dependency-locking output. One line per
 * resolved module, `group:artifact:version=config1,config2`, plus a trailing
 * `empty=` line naming configurations that resolved to nothing.
 */
function parseGradleLockfile(content: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const coordinate = trimmed.split("=")[0].trim();
    const parts = coordinate.split(":");
    if (parts.length !== 3) continue; // `empty=...`, or a shape this reader does not claim to understand
    const [group, artifact, version] = parts;
    if (!group || !artifact) continue;
    out.push({ name: `${group}:${artifact}`, version: literalVersion(version) });
  }
  return dedupe(out);
}

/**
 * Gradle configuration names a dependency declaration may appear under. An
 * allow-list, not a wildcard: `build.gradle` is a *program*, and matching any
 * identifier followed by a string literal would read `description 'uses
 * org.bouncycastle:bcprov for signing'` as a dependency.
 */
const GRADLE_CONFIGURATIONS = new Set([
  "annotationProcessor",
  "api",
  "classpath",
  "compile",
  "compileOnly",
  "compileOnlyApi",
  "developmentOnly",
  "implementation",
  "kapt",
  "ksp",
  "providedCompile",
  "providedRuntime",
  "runtime",
  "runtimeOnly",
  "testAnnotationProcessor",
  "testCompile",
  "testCompileOnly",
  "testImplementation",
  "testRuntimeOnly",
]);

/**
 * `build.gradle` / `build.gradle.kts`, read **only** in its one unambiguous
 * form: a configuration name followed by a single string literal holding the
 * whole coordinate (`implementation 'g:a:1.2.3'`, `api("g:a:1.2.3")`).
 *
 * Everything else a Gradle build can do — map notation, a version catalogue
 * reference (`libs.bouncycastle`), a variable, a loop, a function that returns
 * a coordinate — is skipped rather than guessed at. That is the same trade the
 * rest of this file makes: an unparsed declaration produces *fewer*
 * observations, never wrong ones. A repository that declares its dependencies
 * that way is best submitted as a `gradle.lockfile`.
 */
function parseGradleBuild(content: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z][\w]*)\s*\(?\s*(['"])([^'"\n]+)\2\s*\)?$/);
    if (!match) continue;
    if (!GRADLE_CONFIGURATIONS.has(match[1])) continue;
    const parts = match[3].split(":");
    if (parts.length < 2 || parts.length > 3) continue;
    const [group, artifact, version] = parts;
    if (!group || !artifact) continue;
    out.push({ name: `${group}:${artifact}`, version: literalVersion(version) });
  }
  return dedupe(out);
}

/* ------------------------------------------------------------------ *
 * Go
 * ------------------------------------------------------------------ */

/**
 * Go module paths are case-sensitive, but the module cache and `go.sum` cannot
 * rely on a case-sensitive filesystem, so an upper-case letter is written as
 * `!` followed by its lower-case form. `go.mod` writes the real case. Both
 * files must produce one name or one dependency becomes two assets.
 */
function unescapeGoModulePath(path: string): string {
  return path.replace(/!([a-z])/g, (_whole, letter: string) => letter.toUpperCase());
}

/**
 * `go.mod`. Only `require` is read — `replace` rewrites a path to something
 * local or forked (so the stated module is not what is built), `exclude` and
 * `retract` are the opposite of a dependency, and the `module` line is the
 * project itself.
 */
function parseGoMod(content: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let inRequireBlock = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (inRequireBlock) {
      if (line === ")") {
        inRequireBlock = false;
        continue;
      }
      const [path, version] = line.split(/\s+/);
      if (path && version) out.push({ name: unescapeGoModulePath(path), version: literalVersion(version) });
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      inRequireBlock = true;
      continue;
    }
    const single = line.match(/^require\s+(\S+)\s+(\S+)$/);
    if (single) out.push({ name: unescapeGoModulePath(single[1]), version: literalVersion(single[2]) });
  }
  return dedupe(out);
}

/**
 * `go.sum`. Two lines per module version — one for the module zip, one for its
 * `go.mod` — and the `/go.mod` suffix belongs to the *hash line*, not to the
 * version.
 *
 * **`go.sum` is a superset of what is built.** It records every version the
 * module graph ever considered, including ones minimal version selection
 * rejected, so a package can appear here at a version no build ever used.
 * `go.mod` is the better evidence and both are read; where a target carries
 * both, the version dedupe in the collector keeps each distinct fact.
 */
function parseGoSum(content: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const version = parts[1].replace(/\/go\.mod$/, "");
    out.push({ name: unescapeGoModulePath(parts[0]), version: literalVersion(version) });
  }
  return dedupe(out);
}

/* ------------------------------------------------------------------ *
 * .NET — NuGet
 * ------------------------------------------------------------------ */

/** NuGet package ids are case-insensitive; two files in one repository routinely disagree on the casing. */
function foldNugetId(id: string): string {
  return id.trim().toLowerCase();
}

interface NugetLockEntry {
  type?: string;
  resolved?: string;
  requested?: string;
}

/**
 * `packages.lock.json`. Keyed by target framework, then by package id. Only
 * `resolved` is a pin — `requested` is the range that was asked for, which is
 * the same distinction `requirements.txt` draws between `==` and `>=`.
 */
function parseNugetLockfile(content: string): LockedPackage[] {
  let json: { dependencies?: Record<string, Record<string, NugetLockEntry>> };
  try {
    json = JSON.parse(content);
  } catch {
    return [];
  }
  const out: LockedPackage[] = [];
  for (const perFramework of Object.values(json.dependencies ?? {})) {
    if (!perFramework || typeof perFramework !== "object") continue;
    for (const [id, entry] of Object.entries(perFramework)) {
      if (!id) continue;
      out.push({ name: foldNugetId(id), version: literalVersion(entry?.resolved) });
    }
  }
  return dedupe(out);
}

/** `packages.config` — the pre-PackageReference manifest. `<package id="X" version="Y" />`. */
function parsePackagesConfig(content: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const match of stripXmlComments(content).matchAll(/<package\b([^>]*)\/?>/g)) {
    const id = match[1].match(/\bid\s*=\s*"([^"]+)"/)?.[1];
    if (!id) continue;
    out.push({ name: foldNugetId(id), version: literalVersion(match[1].match(/\bversion\s*=\s*"([^"]*)"/)?.[1]) });
  }
  return dedupe(out);
}

/**
 * `*.csproj` / `*.fsproj` / `*.vbproj` / `Directory.Packages.props`.
 * `<PackageReference>` in both spellings (attribute and child element), plus
 * `<PackageVersion>` — under central package management the version lives only
 * in `Directory.Packages.props` and every project file's reference carries
 * none at all, which is a genuine `undefined` rather than a parse failure.
 */
function parseDotnetProject(content: string): LockedPackage[] {
  const xml = stripXmlComments(content);
  const out: LockedPackage[] = [];

  // Self-closing / attribute form, and the element form whose body may carry <Version>.
  for (const match of xml.matchAll(/<(PackageReference|PackageVersion)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g)) {
    const attributes = match[2];
    const body = match[4] ?? "";
    const id = attributes.match(/\b(?:Include|Update)\s*=\s*"([^"]+)"/i)?.[1];
    if (!id) continue;
    const attributeVersion = attributes.match(/\bVersion\s*=\s*"([^"]*)"/i)?.[1];
    const elementVersion = body.match(/<Version>([^<]*)<\/Version>/i)?.[1];
    out.push({ name: foldNugetId(id), version: literalVersion(attributeVersion ?? elementVersion) });
  }
  return dedupe(out);
}

/* ------------------------------------------------------------------ *
 * Rust — Cargo
 * ------------------------------------------------------------------ */

/**
 * `Cargo.lock`. A sequence of `[[package]]` tables, each with `name` and
 * `version` — exact in every lockfile version Cargo has written. `Cargo.toml`
 * is deliberately not read: its versions are ranges (`rsa = "0.9"`) and its
 * workspace inheritance (`{ workspace = true }`) resolves in another file, the
 * same reason `poetry.lock`/`Pipfile.lock` are not read for PyPI.
 */
function parseCargoLock(content: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  let name: string | undefined;
  let version: string | undefined;
  let inPackage = false;

  const flush = () => {
    if (inPackage && name) out.push({ name, version: literalVersion(version) });
    name = undefined;
    version = undefined;
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[[") || line.startsWith("[")) {
      flush();
      inPackage = line === "[[package]]";
      continue;
    }
    if (!inPackage) continue;
    const match = line.match(/^(name|version)\s*=\s*"([^"]*)"/);
    if (!match) continue;
    if (match[1] === "name") name = match[2];
    else version = match[2];
  }
  flush();
  return dedupe(out);
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
 * Ecosystem-correct name normalisation **for curated-table lookups only**.
 * Nothing customer-facing is built from this — `location`, the purl and the
 * observation's evidence all carry the name as the lockfile spelled it — so
 * folding here can be aggressive without re-fingerprinting an existing asset.
 *
 *  - PyPI: case-insensitive, and runs of `-`, `_` and `.` are equivalent (PEP 503).
 *  - npm / Maven / NuGet: case folded. NuGet ids are formally case-insensitive;
 *    Maven coordinates are case-sensitive but universally lower case in practice.
 *  - Cargo: `_` and `-` are interchangeable in a crate reference. Note that
 *    `-` is **not** removed: `md5` and `md-5` are two different real crates.
 *  - Go: a `/vN` major-version suffix (N ≥ 2) names the same library at a
 *    later major version, so the table holds one entry per library rather than
 *    one per major. Everything before it is a module path and is left alone
 *    apart from the case fold.
 */
export function normalisePackageName(ecosystem: Ecosystem, name: string): string {
  const lower = name.trim().toLowerCase();
  switch (ecosystem) {
    case "pypi":
      return lower.replace(/[-_.]+/g, "-");
    case "cargo":
      return lower.replace(/_/g, "-");
    case "golang":
      return lower.replace(/\/v[1-9]\d*$/, "");
    default:
      return lower;
  }
}

/**
 * Package URL (purl, https://github.com/package-url/purl-spec) for a package.
 * The npm scope is a purl *namespace*, so `@noble/ed25519` is
 * `pkg:npm/%40noble/ed25519` — the `@` must be percent-encoded or the purl
 * cannot be parsed back.
 */
export function purlFor(ecosystem: Ecosystem, name: string, version?: string): string {
  const path = purlPath(ecosystem, name);
  return version ? `pkg:${ecosystem}/${path}@${encodeURIComponent(version)}` : `pkg:${ecosystem}/${path}`;
}

/**
 * The namespace/name half of a purl. A `/` between namespace segments is a
 * purl separator and must **not** be percent-encoded, which is why each
 * segment is encoded individually rather than the whole string at once.
 */
function purlPath(ecosystem: Ecosystem, name: string): string {
  switch (ecosystem) {
    case "npm":
      if (!name.startsWith("@")) return encodeURIComponent(name);
      // The npm scope is a purl namespace, so `@noble/ed25519` is
      // `pkg:npm/%40noble/ed25519` — the `@` must be percent-encoded or the
      // purl cannot be parsed back.
      {
        const [scope, ...rest] = name.slice(1).split("/");
        return `%40${encodeURIComponent(scope)}/${encodeURIComponent(rest.join("/"))}`;
      }
    case "maven": {
      // `pkg:maven/<groupId>/<artifactId>` — the group is the namespace, so
      // the `:` this collector joins them with is not part of the purl.
      const separator = name.indexOf(":");
      if (separator <= 0) return encodeURIComponent(name);
      return `${encodeURIComponent(name.slice(0, separator))}/${encodeURIComponent(name.slice(separator + 1))}`;
    }
    case "golang":
      // A module path is already a `/`-separated namespace: `pkg:golang/
      // github.com/decred/dcrd/dcrec/secp256k1/v4`.
      return name.split("/").map(encodeURIComponent).join("/");
    default:
      return encodeURIComponent(name);
  }
}
