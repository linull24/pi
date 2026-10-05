/**
 * captain (C) — our persistent gateway process.
 *
 * Listens on QQ and routes inbound messages into an active pi session (A) through the side channel
 * (`pi.question` answers / `AgentController.steer`), while agent events (`needs-input` / `finished` /
 * `failed`) are pushed back out to QQ. captain's own work defaults to the agnes model.
 *
 * The channel adapter is injectable so the wiring can be tested without a network. The daemon-facing
 * runner lives in `captain-run.ts`, so this module stays importable without the client graph.
 */

import { createQqBotAdapter } from "./channels/qq.ts";
import {
	type AgentChannelAdapter,
	type AgentChannelMessage,
	registerChannelAdapter,
	routeInboundChannelMessage,
	type SideChannelDeps,
	stopChannelAdapters,
} from "./side-channel.ts";

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
