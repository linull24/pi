/**
 * Route 2: run the interactive entry as a **client of the native daemon**.
 *
 * With daemon-backed sessions the conversation lives in the durable store, so the main TUI can
 * background a session (`←` on an empty prompt) and open the Agent View without losing it. Falls
 * back (returns false) when no daemon is reachable — with a short timeout so `pi` never hangs
 * waiting on daemon discovery.
 */

import { openClientRuntime } from "../experimental/client-runtime.ts";
import { runClientTui } from "../experimental/client-tui.ts";
import type { ClientCommand } from "./experimental/commands/client.ts";

const DISCOVERY_TIMEOUT_MS = 1500;

/** Try to run the daemon-backed TUI. Returns true when it took over, false to fall back. */
export async function runDaemonInteractive(command: ClientCommand): Promise<boolean> {
	const reachable = await Promise.race<boolean>([
		openClientRuntime(command, {}).then(
			async (runtime) => {
				await runtime.dispose();
				return true;
			},
			() => false,
		),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DISCOVERY_TIMEOUT_MS)),
	]);
	if (!reachable) return false;
	await runClientTui(command);
	return true;
}
