/**
 * captain (C) — our persistent gateway process.
 *
 * Listens on QQ and routes inbound messages into an active pi session (A) through the side channel
 * (`pi.question` answers / `AgentController.steer`), while agent events (`needs-input` / `finished` /
 * `failed`) are pushed back out to QQ. captain's own work defaults to the agnes model.
 *
 * The channel adapter is injectable so the wiring can be tested without a network.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createQqBotAdapter } from "./channels/qq.ts";
import { activateBuiltinClientServices, openClientRuntime } from "./client-runtime.ts";
import { AgentController } from "./services/agent-controller.ts";
import { Questions } from "./services/questions.ts";
import {
	type AgentChannelAdapter,
	type AgentChannelMessage,
	registerChannelAdapter,
	routeInboundChannelMessage,
	type SideChannelDeps,
	stopChannelAdapters,
} from "./side-channel.ts";
import { createSessionChannelOpener, createSideChannelDeps } from "./side-channel-sessions.ts";

/** captain defaults to agnes (the same provider hermes used). */
export const CAPTAIN_DEFAULT_MODEL = "agnes/agnes-2.5-flash";

export interface CaptainConfig {
	readonly appId: string;
	readonly clientSecret: string;
	/** Where agent notifications go before a conversation is paired. */
	readonly defaultOpenid?: string;
	/** Map an IM conversation (openid) to a pi session id. */
	resolveSession(openid: string): string | undefined;
	/** Model used for captain's own work; defaults to {@link CAPTAIN_DEFAULT_MODEL}. */
	readonly model?: string;
}

export interface CaptainDeps {
	readonly sideChannel: SideChannelDeps;
	log?(message: string): void;
}

/**
 * Newest durable session that already has a user turn — captain's default target ("the active A").
 * Kept filesystem-only so `pi captain` does not need the whole client TUI.
 */
export function newestSessionFromDisk(): string | undefined {
	const root = path.join(getAgentDir(), "experimental", "sessions");
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

/** Read the QQ credentials captain needs. Returns undefined when they are not configured. */
export function captainConfigFromEnv(
	env: Record<string, string | undefined>,
	resolveSession: CaptainConfig["resolveSession"],
): CaptainConfig | undefined {
	const appId = env.QQ_APP_ID;
	const clientSecret = env.QQ_CLIENT_SECRET;
	if (appId === undefined || appId.length === 0 || clientSecret === undefined || clientSecret.length === 0) {
		return undefined;
	}
	return {
		appId,
		clientSecret,
		defaultOpenid: env.QQBOT_HOME_CHANNEL,
		resolveSession,
		model: env.PI_CAPTAIN_MODEL ?? CAPTAIN_DEFAULT_MODEL,
	};
}

/**
 * Bring captain up: register the QQ channel adapter (which also fans agent events out to QQ) and
 * route inbound QQ messages into the target session. Returns a stop function.
 */
export function startCaptain(
	config: CaptainConfig,
	deps: CaptainDeps,
	createAdapter: (options: Parameters<typeof createQqBotAdapter>[0]) => AgentChannelAdapter = createQqBotAdapter,
): () => void {
	const log = deps.log ?? (() => {});
	const adapter = createAdapter({
		appId: config.appId,
		clientSecret: config.clientSecret,
		defaultOpenid: config.defaultOpenid,
		resolveSession: config.resolveSession,
		log: (message) => log(`[captain] ${message}`),
	});

	const handle = async (message: AgentChannelMessage): Promise<void> => {
		const result = await routeInboundChannelMessage(message, deps.sideChannel);
		log(`[captain] qq message -> ${result.outcome}${"error" in result ? ` (${result.error})` : ""}`);
	};

	const unregister = registerChannelAdapter(adapter, (message) => void handle(message));
	log(`[captain] up on QQ (model ${config.model ?? CAPTAIN_DEFAULT_MODEL})`);

	return () => {
		unregister();
		stopChannelAdapters();
	};
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

	const shutdown = async (): Promise<void> => {
		stop();
		await runtime.dispose();
	};
	process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
	process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
	log(`[captain] running against session ${sessionId}`);
	await new Promise<void>(() => {});
}
