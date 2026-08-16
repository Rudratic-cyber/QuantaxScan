import { logger } from "./logger";

/**
 * HTML → PDF, via headless Chromium.
 * docs/Claude/07-reports.md §Rendering: "HTML source of truth → PDF via
 * headless Chrome … Do not build two renderers." This module is the *only*
 * impure part of report generation; everything it prints came out of
 * `report-html.ts`, which is what the `.html` endpoints already serve.
 *
 * **Why `playwright-core` and a dynamic import.**
 *
 *  - `playwright-core` ships no browser. Adding the full `playwright` package
 *    would download ~150 MB of Chromium on every `pnpm install` in every
 *    worktree and CI job, to serve one endpoint. The browser is located at run
 *    time instead: from `QUANTAXSCAN_CHROMIUM_PATH` if set, otherwise from
 *    whatever Playwright's own browser registry has installed.
 *  - The import is dynamic, and `playwright-core` is in `build.mjs`'s `external`
 *    list, so the esbuild bundle does not try to inline it and a deployment
 *    without a browser still starts. It answers `PdfUnavailableError` on the
 *    two `.pdf` routes and serves everything else normally.
 *
 * **`Dockerfile.api` installs no browser today**, so the `.pdf` endpoints are
 * expected to 503 there until it does; the `.html` endpoint is the fallback and
 * it is the same document. That is stated in the route's OpenAPI description
 * rather than left for someone to discover in production.
 */

export class PdfUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(
      "PDF rendering is unavailable in this deployment: " +
        reason +
        ". The identical document is available as HTML from the same route with the `.html` suffix.",
    );
    this.name = "PdfUnavailableError";
  }
}

/** How long a single render may take before it is abandoned. A report that hangs must not hold a worker. */
const RENDER_TIMEOUT_MS = Number(process.env.REPORT_PDF_TIMEOUT_MS ?? 30_000);

type ChromiumLauncher = {
  launch(options: { args?: string[]; executablePath?: string }): Promise<{
    newPage(): Promise<{
      setContent(html: string, options: { waitUntil: "load" }): Promise<void>;
      pdf(options: Record<string, unknown>): Promise<Buffer>;
    }>;
    close(): Promise<void>;
  }>;
};

async function loadChromium(): Promise<ChromiumLauncher> {
  try {
    // Not a static import: see the header. The specifier is built at run time so
    // that a bundler cannot decide to resolve it eagerly either.
    const specifier = "playwright-core";
    const module_ = (await import(/* @vite-ignore */ specifier)) as { chromium: ChromiumLauncher };
    return module_.chromium;
  } catch (err) {
    throw new PdfUnavailableError(
      `the playwright-core package could not be loaded (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Renders a complete HTML document to A4 PDF bytes.
 *
 * `setContent` rather than a navigation to a URL: the markup is already in
 * hand, it is fully self-contained (see `report-html.ts`), and giving a browser
 * a URL would mean re-authenticating the request from inside the server.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const chromium = await loadChromium();

  let browser: Awaited<ReturnType<ChromiumLauncher["launch"]>> | null = null;
  try {
    browser = await chromium.launch({
      // The API server commonly runs as root in a container, where Chromium's
      // sandbox cannot initialise. The page renders a string this process
      // produced and loads nothing from the network, so there is no untrusted
      // navigation for the sandbox to contain.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      ...(process.env.QUANTAXSCAN_CHROMIUM_PATH === undefined
        ? {}
        : { executablePath: process.env.QUANTAXSCAN_CHROMIUM_PATH }),
    });
  } catch (err) {
    throw new PdfUnavailableError(
      `no Chromium executable could be launched (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", bottom: "16mm", left: "0mm", right: "0mm" },
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%;font:8pt sans-serif;color:#55606f;padding:0 14mm;">' +
        '<span style="float:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
        "</div>",
      timeout: RENDER_TIMEOUT_MS,
    });
  } finally {
    await browser.close().catch((err: unknown) => logger.warn({ err }, "Failed to close the PDF rendering browser"));
  }
}
