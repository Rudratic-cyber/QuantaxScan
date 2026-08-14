/**
 * Process plumbing for the e2e stack.
 *
 * Two rules encoded here, both learned the hard way by suites that pass while
 * proving nothing:
 *
 *  - A child that dies is fatal, immediately and by name. A server that
 *    exited during startup must not be discovered later as a connection
 *    refusal in the middle of an assertion.
 *  - Nothing is ever "waited for" with a sleep. Readiness is a probe against
 *    the thing itself.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { LOG_DIR, REPO_ROOT } from "./config";

export type Managed = {
  name: string;
  child: ChildProcess;
  output: () => string;
  logFile: string;
};

/** Runs a command to completion, throwing with its output when it fails. */
export function run(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));

    child.on("error", (error) => reject(new Error(`${name}: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${name} exited with code ${code}\n${indent(output)}`));
    });
  });
}

/**
 * Starts a long-running child, with its output going to a file rather than a
 * pipe.
 *
 * A pipe would be simpler, but the read end closes when the Playwright process
 * exits — and the next thing the server logs then kills it with EPIPE. That
 * costs nothing on a normal run, where teardown stops it anyway, and takes
 * `E2E_KEEP_STACK=1` (leave the stack up and poke at it) from useful to
 * useless. A file also means the log survives the run for a post-mortem.
 */
export function start(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Managed {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `${name}.log`);
  const fd = openSync(logFile, "w");

  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd],
    // Own process group, so stopping it also stops the package manager's
    // grandchildren rather than orphaning a server on the port.
    detached: true,
  });

  return {
    name,
    child,
    logFile,
    output: () => {
      try {
        return readFileSync(logFile, "utf8").slice(-8_000);
      } catch {
        return "";
      }
    },
  };
}

export function stop(pid: number | null | undefined): void {
  if (!pid) return;
  try {
    // Negative pid: the whole process group started by `start()`.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

export function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  │ ${line}`)
    .join("\n");
}

/**
 * Polls `probe` until it resolves truthy, failing with the managed process's
 * output when it does not. If the process exits first the wait ends there —
 * a dead server is reported as a dead server, not as a timeout.
 */
export async function waitUntilReady(
  managed: Managed | null,
  what: string,
  probe: () => Promise<boolean>,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited: number | null = null;
  managed?.child.on("exit", (code) => (exited = code ?? -1));

  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(
        `${what} exited with code ${exited} before becoming ready.\n${indent(managed?.output() ?? "")}`,
      );
    }
    if (await probe().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `${what} did not become ready within ${timeoutMs}ms.\n${indent(managed?.output() ?? "")}`,
  );
}
