/**
 * Native daemon CLI dispatch.
 *
 * `pi server`, `pi client`, `pi agents`, `pi resume`, and `pi queue` are part of the coding-agent
 * CLI (not a source-only experimental entry). `main.ts` loads this module lazily, so normal
 * sessions never evaluate the daemon graph.
 */

import { runExperimentalCommand } from "../experimental/commands.ts";
import { handleDaemonCommand } from "../experimental/daemon-commands.ts";

/** Run a daemon subcommand. Returns true when the arguments were handled. */
export async function runDaemonCli(args: string[]): Promise<boolean> {
	// `pi agents` / `pi resume` / `pi queue` (codex-style surface).
	if (await handleDaemonCommand(args)) return true;
	// `pi server` / `pi client` (the durable session server and its TUI/print client).
	if (await runExperimentalCommand(args)) return true;
	return false;
}
