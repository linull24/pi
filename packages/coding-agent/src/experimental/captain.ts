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

/** A captain state transition worth pushing out to IM. */
export type CaptainEventKind = "needs-input" | "finished" | "failed";

/**
 * Map a session-state transition to an outbound event, or undefined when nothing should be sent.
 * `needs-input` fires on entry; `finished` on leaving an active state for `needs-instructions`/`done`;
 * `failed` on entry. Pure so the rules can be tested without a daemon.
 */
export function transitionEvent(previous: string | undefined, next: string): CaptainEventKind | undefined {
	if (previous === next) return undefined;
	if (next === "needs-input") return "needs-input";
	if (next === "failed") return "failed";
	if (next === "done") return "finished";
	const wasActive = previous === "working" || previous === "finishing";
	if (next === "needs-instructions" && wasActive) return "finished";
	return undefined;
}

/**
 * captain's outbound watch: poll the attached session's state and emit on transitions. Notifications
 * are produced inside the daemon worker (request_input / the client poller), so captain — a separate
 * process — watches the durable session itself and pushes the events out to IM.
 */
export function startCaptainStateWatch(options: {
	readState(): string;
	intervalMs?: number;
	onEvent(kind: CaptainEventKind): void;
	log?(message: string): void;
}): () => void {
	const interval = options.intervalMs ?? 4_000;
	let previous: string | undefined;
	const tick = (): void => {
		let next: string;
		try {
			next = options.readState();
		} catch (error) {
			options.log?.(`[captain] state read failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const kind = transitionEvent(previous, next);
		previous = next;
		if (kind !== undefined) {
			try {
				options.onEvent(kind);
			} catch (error) {
				options.log?.(`[captain] notify failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};
	tick();
	const timer = setInterval(tick, interval);
	timer.unref?.();
	return () => clearInterval(timer);
}
