/**
 * captain runner — the daemon-facing entry (`pi captain`).
 *
 * Kept apart from `captain.ts` so the pure wiring (config + adapter) can be imported and tested
 * without pulling in the daemon/client graph.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { captainConfigFromEnv, startCaptain, startCaptainStateWatch } from "./captain.ts";
import { activateBuiltinClientServices, openClientRuntime } from "./client-runtime.ts";
import { emitAgentNotification } from "./notify.ts";
import { AgentController } from "./services/agent-controller.ts";
import { Questions } from "./services/questions.ts";
import { createSessionChannelOpener, createSideChannelDeps } from "./side-channel-sessions.ts";

/**
 * Newest durable session that already has a user turn — captain's default target ("the active A").
 * Kept filesystem-only so `pi captain` does not need the whole client TUI.
 */
export function newestSessionFromDisk(): string | undefined {
	const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const root = path.join(agentDir, "experimental", "sessions");
	let ids: string[];
	try {
		ids = fs.readdirSync(root);
	} catch {
		return undefined;
	}
	const candidates: Array<{ id: string; at: number }> = [];
	for (const id of ids) {
		try {
			const dbPath = path.join(root, id, "session.sqlite");
			const db = new DatabaseSync(dbPath, { readOnly: true });
			try {
				const row = db
					.prepare("select count(*) as c from entries where json_extract(record,'$.kind')='pi.user'")
					.get() as unknown as { c?: number };
				if ((row?.c ?? 0) > 0) candidates.push({ id, at: fs.statSync(dbPath).mtimeMs });
			} finally {
				db.close();
			}
		} catch {
			// skip unreadable session
		}
	}
	candidates.sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
	return candidates[0]?.id;
}

/**
 * Read a session's durable state from its sqlite (task status + pending `pi.question`). Mirrors the
 * client's mapping so captain can watch the same states from its own process.
 */
export function readSessionState(sessionId: string, agentDir?: string): string {
	const dir = agentDir ?? process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const dbPath = path.join(dir, "experimental", "sessions", sessionId, "session.sqlite");
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		let state = "needs-instructions";
		const task = db
			.prepare("select status, record from tasks where kind = 'pi.generation' order by id desc limit 1")
			.get() as unknown as { status?: string; record?: string } | undefined;
		if (task?.status === "completing") state = "finishing";
		else if (task?.status === "pending" || task?.status === "running" || task?.status === "waiting")
			state = "working";
		else if (task?.status === "terminal") {
			state = /"(?:error|is_error)":\s*(?:"[^"]+"|true)/u.test(task.record ?? "") ? "failed" : "needs-instructions";
		}
		const question = db
			.prepare(
				"select r.content from document_revisions r join documents d on d.id = r.document_id where d.kind = '\"pi.question\"' order by r.seq desc limit 1",
			)
			.get() as unknown as { content?: string } | undefined;
		if (question?.content !== undefined) {
			const doc = JSON.parse(question.content) as { status?: string };
			if (doc.status === "pending") state = "needs-input";
		}
		return state;
	} finally {
		db.close();
	}
}

/**
 * Run captain against the native daemon: attach to the target session and route QQ messages into it
 * (v1 steers the session; answering a pending `pi.question` comes later). Keeps running until
 * SIGINT/SIGTERM. Used by the `pi captain` entry point.
 */
export async function runCaptain(
	options: {
		sessionId?: string;
		directory?: string;
		env?: Record<string, string | undefined>;
		log?(message: string): void;
	} = {},
): Promise<void> {
	const env = options.env ?? process.env;
	const log = options.log ?? ((message: string) => console.log(message));
	const sessionId = options.sessionId ?? env.PI_CAPTAIN_SESSION ?? newestSessionFromDisk();
	if (sessionId === undefined || sessionId.length === 0) {
		throw new Error("captain needs a target session (set PI_CAPTAIN_SESSION)");
	}
	const config = captainConfigFromEnv(env, () => sessionId);
	if (config === undefined) {
		throw new Error("captain needs QQ_APP_ID / QQ_CLIENT_SECRET");
	}

	const runtime = await openClientRuntime({ command: "client" }, { directory: options.directory });
	const server = runtime.servers[0];
	if (server === undefined) throw new Error("captain: no daemon server reachable");
	// Attaching is what makes the session the client's current attachment; `whenAttached` alone only
	// waits for an attachment that was already requested.
	const activated = await activateBuiltinClientServices(server);
	await activated.management.attach(sessionId, BACKGROUND_CONTEXT);

	const opener = createSessionChannelOpener(
		{ open: (openOptions) => server.session.open(openOptions) },
		{ Questions, AgentController },
		async () => false,
	);
	const stop = startCaptain(config, { sideChannel: createSideChannelDeps(opener), log });
	const stopWatch = startCaptainStateWatch({
		readState: () => readSessionState(sessionId),
		onEvent: (kind) =>
			emitAgentNotification({
				kind,
				title: "captain",
				message:
					kind === "needs-input"
						? "A session needs your input"
						: kind === "failed"
							? "A session failed"
							: "A session finished",
				sessionId,
			}),
		log,
	});

	const shutdown = async (): Promise<void> => {
		stopWatch();
		stop();
		await runtime.dispose();
	};
	process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
	process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
	log(`[captain] running against session ${sessionId}`);
	await new Promise<void>(() => {});
}
