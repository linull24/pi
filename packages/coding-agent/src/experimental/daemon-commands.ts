/**
 * Daemon subcommands: `pi agents`, `pi resume`, `pi queue`, and the `--resume` compat flag.
 *
 * These operate on the shared local durable-session server (the native pi daemon). They mirror
 * Codex's surface (`codex agents`, `codex resume`, `codex queue`) and also accept the Claude
 * Code-style `pi --resume`, so both habits work.
 *
 * This module lives in the experimental graph on purpose: the published coding-agent entrypoint
 * must not import the daemon/protocol packages (see `check:runtime-deps`). It is dispatched from
 * `experimental/cli.ts`, the source-only entry point.
 */

import chalk from "chalk";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { listAgentSessions } from "./agent-sessions.ts";
import { activateBuiltinClientServices, openClientRuntime } from "./client-runtime.ts";
import { runClientCommand } from "./commands.ts";

/** Resolve `--last` to the newest daemon Session id (by createdAt). */
async function newestSessionId(): Promise<string | undefined> {
	const runtime = await openClientRuntime({ command: "client" }, {});
	try {
		const discovered = await Promise.all(runtime.servers.map(activateBuiltinClientServices));
		const sessions = discovered.flatMap(({ route, directory }) =>
			directory.state.value!.sessions.map((session) => ({
				serverId: route.serverId,
				sessionId: session.sessionId,
				createdAt: session.createdAt ?? 0,
			})),
		);
		sessions.sort(
			(left, right) =>
				right.createdAt - left.createdAt ||
				right.serverId.localeCompare(left.serverId) ||
				right.sessionId.localeCompare(left.sessionId),
		);
		return sessions[0]?.sessionId;
	} finally {
		await runtime.dispose();
	}
}

/** Parse the resume arguments: --last, --all, an id, and an optional prompt. */
async function parseResume(rest: string[]): Promise<ClientCommand> {
	let last = false;
	let sessionId: string | undefined;
	let prompt: string | undefined;
	for (const arg of rest) {
		if (arg === "--last") last = true;
		else if (arg === "--all") {
			// accepted for Codex parity; daemon listing ignores cwd filtering anyway
		} else if (!last && !sessionId && !arg.startsWith("-")) sessionId = arg;
		else if (!prompt) prompt = arg;
	}

	if (last) {
		const resolved = await newestSessionId();
		if (resolved) sessionId = resolved;
	}
	const command: ClientCommand = {
		command: "client",
		...(sessionId ? { sessionId } : {}),
		...(prompt ? { prompt } : {}),
	};
	// no id and no --last => open the picker (Codex/Claude default)
	return command;
}

/**
 * Handle `agents` / `resume` / `queue` / `--resume`. Returns true when the command was handled.
 */
export async function handleDaemonCommand(args: string[]): Promise<boolean> {
	const command = args[0];
	if (command !== "agents" && command !== "resume" && command !== "queue") {
		return false;
	}

	try {
		if (command === "agents") {
			const rest = args.slice(1);
			if (rest.includes("--json")) {
				// Scriptable session list (Claude parity: `claude agents --json`).
				const sessions = listAgentSessions();
				const active = sessions.filter(
					(session) =>
						session.state === "working" || session.state === "needs-input" || session.state === "finishing",
				);
				console.log(JSON.stringify(rest.includes("--all") ? sessions : active, null, 2));
				return true;
			}
			// Same Agent View as pressing ← inside a session (Claude/Codex parity).
			await runClientCommand({ command: "client", agents: true });
			return true;
		}

		if (command === "queue") {
			const rest = args.slice(1);
			let thread: string | undefined;
			let message: string | undefined;
			for (let i = 0; i < rest.length; i++) {
				if (rest[i] === "--thread") thread = rest[++i];
				else if (rest[i] === "--message" || rest[i] === "-m") message = rest[++i];
			}
			if (!thread || !message) {
				console.error(chalk.red("Usage: pi queue --thread <id> --message <text>"));
				process.exitCode = 1;
				return true;
			}
			await runClientCommand({ command: "client", sessionId: thread, prompt: message });
			return true;
		}

		// resume (subcommand; `--resume` is left to the native session picker)
		await runClientCommand(await parseResume(args.slice(1)));
		return true;
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
		return true;
	}
}
