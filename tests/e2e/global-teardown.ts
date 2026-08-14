/**
 * Stops everything global setup started, including after a failed run.
 *
 * Set `E2E_KEEP_STACK=1` to leave it up for manual inspection — the state file
 * names the container and the two process groups.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { STATE_FILE, type StackState } from "./support/config";
import { dropContainer } from "./support/database";
import { stop } from "./support/process";

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;

  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as StackState;

  if (process.env["E2E_KEEP_STACK"] === "1") {
    process.stdout.write(`  e2e stack · left running (state: ${STATE_FILE})\n`);
    return;
  }

  stop(state.apiPid);
  stop(state.uiPid);
  if (state.startedContainer) await dropContainer();

  rmSync(STATE_FILE, { force: true });
  process.stdout.write("  e2e stack · torn down\n");
}
