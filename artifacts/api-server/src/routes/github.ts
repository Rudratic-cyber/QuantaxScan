import { Router, type IRouter, type Request, type Response } from "express";
import { scanCode, computeScanResult, generateExecutiveSummary } from "../lib/scanner";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const SCANNABLE_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".go", ".java", ".cs", ".cpp", ".c", ".rb", ".php",
  ".rs", ".kt", ".swift", ".scala", ".sh", ".tsx", ".jsx",
]);

const MAX_FILES         = 25;
const MAX_FILE_SIZE     = 150_000;
const MAX_CONTENT_LINES = 300;
const MAX_TREE_NODES    = 500;
const TREE_CACHE_TTL_MS = 30 * 60 * 1000;  // 30 min
const FILE_CACHE_TTL_MS = 60 * 60 * 1000;  // 60 min

// ── Tree cache ────────────────────────────────────────────────────────────────
interface CachedTree {
  tree: Array<{ path: string; type: string; size?: number }>;
  truncated: boolean;
  branch: string;
  ts: number;
}
const treeCache = new Map<string, CachedTree>();

function getCachedTree(key: string): CachedTree | null {
  const entry = treeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TREE_CACHE_TTL_MS) { treeCache.delete(key); return null; }
  return entry;
}
function setCachedTree(key: string, data: Omit<CachedTree, "ts">): void {
  treeCache.set(key, { ...data, ts: Date.now() });
  if (treeCache.size > 100) {
    const oldest = [...treeCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    treeCache.delete(oldest[0]);
  }
}

// ── File content cache ────────────────────────────────────────────────────────
interface CachedFile { content: string; ts: number; }
const fileCache = new Map<string, CachedFile>();

function getCachedFile(key: string): string | null {
  const entry = fileCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > FILE_CACHE_TTL_MS) { fileCache.delete(key); return null; }
  return entry.content;
}
function setCachedFile(key: string, content: string): void {
  fileCache.set(key, { content, ts: Date.now() });
  if (fileCache.size > 500) {
    const oldest = [...fileCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    fileCache.delete(oldest[0]);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("github.com")) return null;
    const parts = u.pathname.replace(/^\//, "").split("/");
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
  } catch { return null; }
}

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

function detectLanguage(path: string): string {
  const ext = getExtension(path);
  const map: Record<string, string> = {
    ".py": "python", ".js": "javascript", ".ts": "typescript", ".go": "go",
    ".java": "java", ".cs": "csharp", ".cpp": "cpp", ".c": "c",
    ".rb": "ruby", ".php": "php", ".rs": "rust", ".kt": "kotlin",
    ".swift": "swift", ".tsx": "typescript", ".jsx": "javascript",
  };
  return map[ext] ?? "unknown";
}

function makeGitHubHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "q-vuln-scanner/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    h["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  } else {
    logger.warn("GITHUB_TOKEN is not set — using unauthenticated GitHub API (60 req/hour limit)");
  }
  return h;
}

// ── Fetch with retry + exponential backoff ────────────────────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      // On 429 or 403 (rate limit), respect Retry-After or back off
      if (res.status === 429 || res.status === 403) {
        const retryAfter = res.headers.get("Retry-After");
        const resetAt    = res.headers.get("X-RateLimit-Reset");
        if (attempt < maxRetries - 1) {
          const waitMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : resetAt
            ? Math.max(0, parseInt(resetAt, 10) * 1000 - Date.now())
            : Math.pow(2, attempt) * 1000;
          const clampedWait = Math.min(waitMs, 8000); // wait at most 8s per retry
          logger.warn({ url, attempt, waitMs: clampedWait }, "Rate limited — backing off");
          await new Promise(r => setTimeout(r, clampedWait));
          continue;
        }
      }
      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
      }
    }
  }
  throw lastError ?? new Error("fetch failed after retries");
}

// ── Fetch repo tree ───────────────────────────────────────────────────────────
async function fetchRepoTree(
  owner: string, repo: string, headers: Record<string, string>,
): Promise<CachedTree | { error: string; status: number; rateLimit?: boolean; resetAt?: number }> {
  const cacheKey = `${owner}/${repo}`;
  const cached = getCachedTree(cacheKey);
  if (cached) {
    logger.info({ owner, repo }, "Serving tree from cache");
    return cached;
  }

  try {
    const res = await fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
      { headers },
    );

    // Log remaining quota after each API call
    const remaining = res.headers.get("X-RateLimit-Remaining");
    const resetAt   = res.headers.get("X-RateLimit-Reset");
    const limit     = res.headers.get("X-RateLimit-Limit");
    if (remaining !== null) {
      logger.info({ owner, repo, remaining, limit, resetAt }, "GitHub API rate limit status");
    }

    if (!res.ok) {
      const resetSec = resetAt ? parseInt(resetAt, 10) : null;
      if (res.status === 404)
        return { error: "Repository not found. Make sure it is public.", status: 404 };
      if (res.status === 403 || res.status === 429) {
        const resetMin = resetSec ? Math.ceil((resetSec * 1000 - Date.now()) / 60000) : null;
        return {
          error: resetMin
            ? `GitHub API rate limit reached — resets in ${resetMin} min. Add a personal access token to increase the limit.`
            : "GitHub API rate limit reached. Please try again later.",
          status: 429,
          rateLimit: true,
          resetAt: resetSec ?? undefined,
        };
      }
      return { error: `GitHub API error: HTTP ${res.status}`, status: 502 };
    }

    const data = await res.json() as { tree: Array<{ path: string; type: string; size?: number }>; truncated?: boolean };
    const branch = await detectBranch(owner, repo, headers);
    const result: CachedTree = { tree: data.tree, truncated: data.truncated ?? false, branch };
    setCachedTree(cacheKey, result);
    return result;
  } catch (err) {
    logger.error({ err }, "Failed to fetch GitHub tree");
    return { error: "Failed to reach GitHub API — check your network connection.", status: 502 };
  }
}

// ── Detect default branch ─────────────────────────────────────────────────────
async function detectBranch(owner: string, repo: string, headers: Record<string, string>): Promise<string> {
  const [mainRes, masterRes] = await Promise.allSettled([
    fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`, { method: "HEAD", headers }),
    fetch(`https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`, { method: "HEAD", headers }),
  ]);
  if (mainRes.status === "fulfilled" && mainRes.value.ok) return "main";
  if (masterRes.status === "fulfilled" && masterRes.value.ok) return "master";
  return "main";
}

// ── Fetch raw file — authenticated + cached ───────────────────────────────────
async function fetchRawFile(
  owner: string, repo: string, branch: string, filePath: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const branches = branch === "main" ? ["main", "master"] : ["master", "main"];
  for (const b of branches) {
    const cacheKey = `raw:${owner}/${repo}/${b}/${filePath}`;
    const cached = getCachedFile(cacheKey);
    if (cached !== null) return cached;

    try {
      // Pass auth headers so raw.githubusercontent.com counts against the authenticated quota
      const res = await fetchWithRetry(
        `https://raw.githubusercontent.com/${owner}/${repo}/${b}/${filePath}`,
        { headers },
        2,
      );
      if (res.ok) {
        const text = await res.text();
        setCachedFile(cacheKey, text);
        return text;
      }
    } catch { /* try next branch */ }
  }
  return null;
}

// ── Scan a set of candidate files ─────────────────────────────────────────────
async function fetchAndScanFiles(
  owner: string, repo: string, branch: string,
  candidates: Array<{ path: string; size?: number }>,
  headers: Record<string, string>,
): Promise<Array<{ path: string; language: string; content: string; findings: ReturnType<typeof scanCode>; lines: number }>> {
  const results: Array<{ path: string; language: string; content: string; findings: ReturnType<typeof scanCode>; lines: number }> = [];
  // Process in batches of 5 to avoid overwhelming raw.githubusercontent.com
  const BATCH = 5;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    await Promise.all(batch.map(async (file) => {
      const raw = await fetchRawFile(owner, repo, branch, file.path, headers);
      if (!raw) return;
      const codeLines = raw.split("\n");
      const lang = detectLanguage(file.path);
      const findings = scanCode(raw, file.path, lang);
      const content = codeLines.slice(0, MAX_CONTENT_LINES).join("\n") +
        (codeLines.length > MAX_CONTENT_LINES ? `\n// ... (${codeLines.length - MAX_CONTENT_LINES} more lines)` : "");
      results.push({ path: file.path, language: lang, content, findings, lines: codeLines.length });
    }));
  }
  return results;
}

// ── Route: rate limit status ──────────────────────────────────────────────────
router.get("/github/rate-limit", async (_req: Request, res: Response): Promise<void> => {
  const headers = makeGitHubHeaders();
  try {
    const r = await fetch("https://api.github.com/rate_limit", { headers });
    const data = await r.json() as { resources: { core: { limit: number; remaining: number; reset: number } } };
    const core = data.resources.core;
    const resetMs = core.reset * 1000;
    res.json({
      authenticated: !!process.env.GITHUB_TOKEN,
      limit: core.limit,
      remaining: core.remaining,
      resetAt: new Date(resetMs).toISOString(),
      resetsInMin: Math.ceil((resetMs - Date.now()) / 60000),
    });
  } catch {
    res.status(502).json({ error: "Could not reach GitHub API" });
  }
});

// ── Route: one-shot scan ──────────────────────────────────────────────────────
router.post("/github/scan", async (req: Request, res: Response): Promise<void> => {
  const { repoUrl } = req.body as { repoUrl?: string };
  if (!repoUrl || typeof repoUrl !== "string") { res.status(400).json({ error: "repoUrl is required" }); return; }
  const parsed = parseGithubUrl(repoUrl.trim());
  if (!parsed) { res.status(400).json({ error: "Invalid GitHub URL." }); return; }
  const { owner, repo } = parsed;
  const headers = makeGitHubHeaders();

  const treeResult = await fetchRepoTree(owner, repo, headers);
  if ("error" in treeResult) { res.status(treeResult.status).json({ error: treeResult.error, rateLimit: treeResult.rateLimit, resetAt: treeResult.resetAt }); return; }

  const candidates = treeResult.tree
    .filter(f => f.type === "blob" && SCANNABLE_EXTENSIONS.has(getExtension(f.path ?? "")) && (f.size ?? 0) <= MAX_FILE_SIZE)
    .slice(0, MAX_FILES);

  if (!candidates.length) {
    res.json({ repoUrl, owner, repo, totalFiles: 0, findings: [], criticalCount: 0, alertCount: 0, cleanCount: 0, riskScore: 0, totalLines: 0, executiveSummary: "No scannable source files found.", fileResults: [] }); return;
  }

  const fileResults = await fetchAndScanFiles(owner, repo, treeResult.branch, candidates, headers);
  const allFindings = fileResults.flatMap(f => f.findings);
  const totalLines  = fileResults.reduce((acc, f) => acc + f.lines, 0);
  const result      = computeScanResult(allFindings, totalLines);
  const primaryLang = fileResults.length ? [...fileResults].sort((a, b) => b.lines - a.lines)[0].language : "unknown";

  res.json({
    repoUrl, owner, repo, totalFiles: fileResults.length, findings: allFindings,
    criticalCount: result.criticalCount, alertCount: result.alertCount,
    cleanCount: result.cleanCount, riskScore: result.riskScore, totalLines,
    totalEffortHours: result.totalEffortHours, executiveSummary: generateExecutiveSummary(allFindings, totalLines, primaryLang),
    fileResults: fileResults.map(f => ({
      path: f.path, language: f.language, lines: f.lines, content: f.content, findings: f.findings,
      criticalCount: f.findings.filter(x => x.severity === "critical").length,
      alertCount:    f.findings.filter(x => x.severity === "alert").length,
    })),
  });
});

// ── Route: PHASE 1 — fetch repo tree + file contents ─────────────────────────
router.post("/github/fetch", async (req: Request, res: Response): Promise<void> => {
  const { repoUrl } = req.body as { repoUrl?: string };
  if (!repoUrl || typeof repoUrl !== "string") { res.status(400).json({ error: "repoUrl is required" }); return; }
  const parsed = parseGithubUrl(repoUrl.trim());
  if (!parsed) { res.status(400).json({ error: "Invalid GitHub URL. Use format: https://github.com/owner/repo" }); return; }
  const { owner, repo } = parsed;
  const headers = makeGitHubHeaders();

  const treeResult = await fetchRepoTree(owner, repo, headers);
  if ("error" in treeResult) { res.status(treeResult.status).json({ error: treeResult.error, rateLimit: treeResult.rateLimit, resetAt: treeResult.resetAt }); return; }

  const fullTree = treeResult.tree
    .filter(f => f.type === "blob" || f.type === "tree")
    .slice(0, MAX_TREE_NODES * 2)
    .map(f => ({ path: f.path, type: f.type as "blob" | "tree", size: f.size }));

  const totalFileCount = treeResult.tree.filter(f => f.type === "blob").length;

  const candidates = treeResult.tree
    .filter(f => f.type === "blob" && SCANNABLE_EXTENSIONS.has(getExtension(f.path ?? "")) && (f.size ?? 0) <= MAX_FILE_SIZE)
    .slice(0, MAX_FILES);

  const fetchedFiles: Array<{ path: string; language: string; content: string; lines: number }> = [];
  const BATCH = 5;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    await Promise.all(batch.map(async (file) => {
      const raw = await fetchRawFile(owner, repo, treeResult.branch, file.path, headers);
      if (!raw) return;
      const codeLines = raw.split("\n");
      const lang = detectLanguage(file.path);
      const content = codeLines.slice(0, MAX_CONTENT_LINES).join("\n") +
        (codeLines.length > MAX_CONTENT_LINES ? `\n// ... (${codeLines.length - MAX_CONTENT_LINES} more lines)` : "");
      fetchedFiles.push({ path: file.path, language: lang, content, lines: codeLines.length });
    }));
  }

  res.json({ owner, repo, repoUrl, branch: treeResult.branch, totalNodes: totalFileCount, truncated: treeResult.truncated, fullTree, fetchedFiles });
});

// ── Route: PHASE 2 — scan pre-fetched files (zero GitHub API calls) ───────────
router.post("/github/scan-files", async (req: Request, res: Response): Promise<void> => {
  const { repoUrl, owner, repo, files } = req.body as {
    repoUrl: string; owner: string; repo: string;
    files: Array<{ path: string; content: string; language: string; lines: number }>;
  };
  if (!files || !Array.isArray(files) || !files.length) { res.status(400).json({ error: "files array is required" }); return; }

  const fileResults: Array<{ path: string; language: string; content: string; findings: ReturnType<typeof scanCode>; lines: number }> = [];
  for (const file of files.slice(0, MAX_FILES)) {
    try {
      fileResults.push({ path: file.path, language: file.language, content: file.content, findings: scanCode(file.content, file.path, file.language), lines: file.lines });
    } catch { /* skip */ }
  }

  const allFindings = fileResults.flatMap(f => f.findings);
  const totalLines  = files.reduce((acc, f) => acc + f.lines, 0);
  const result      = computeScanResult(allFindings, totalLines);
  const primaryLang = fileResults.length ? [...fileResults].sort((a, b) => b.lines - a.lines)[0].language : "unknown";

  res.json({
    repoUrl, owner, repo, totalFiles: fileResults.length, findings: allFindings,
    criticalCount: result.criticalCount, alertCount: result.alertCount,
    cleanCount: result.cleanCount, riskScore: result.riskScore,
    totalLines, totalEffortHours: result.totalEffortHours,
    executiveSummary: generateExecutiveSummary(allFindings, totalLines, primaryLang),
    fileResults: fileResults.map(f => ({
      path: f.path, language: f.language, lines: f.lines, content: f.content, findings: f.findings,
      criticalCount: f.findings.filter(x => x.severity === "critical").length,
      alertCount:    f.findings.filter(x => x.severity === "alert").length,
    })),
  });
});

export default router;
