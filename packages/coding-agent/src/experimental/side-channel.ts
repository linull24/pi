/**
 * Side channel: the out-of-band IM path, in both directions.
 *
 * - outbound: agent events (needs-input / finished / failed) are fanned into every registered
 *   channel adapter (QQ bot, Telegram, a local bridge, …) via `emitAgentNotification`;
 * - inbound: an adapter hands a message to the router, which either answers a pending durable
 *   `pi.question` or steers the session with a new instruction.
 *
 * The routing decision is pure and injected, so it is unit-testable without the daemon. The daemon
 * wires the real `Questions` / `AgentController` services into `SideChannelDeps`.
 *
 * This is the mechanism that lets a user who left a TUI running deal with a problem from a phone.
 */

import { type AgentNotification, registerNotificationChannel } from "./notify.ts";

/** One inbound message from an IM channel. */
export interface AgentChannelMessage {
	/** Adapter id, e.g. "qq". */
	readonly channel: string;
	/** Target session; adapters derive it from a paired conversation when omitted. */
	readonly sessionId: string | undefined;
	readonly text: string;
	/** Sender label, kept for audit. */
	readonly from?: string;
}

/** Injected effects used to route an inbound message. */
export interface SideChannelDeps {
	hasPendingQuestion(sessionId: string): Promise<boolean>;
	answerQuestion(sessionId: string, text: string): Promise<{ readonly ok: boolean; readonly error?: string }>;
	steer(sessionId: string, text: string): Promise<{ readonly accepted: boolean; readonly error?: string }>;
}

export type SideChannelOutcome =
	| { readonly outcome: "answered" }
	| { readonly outcome: "steered" }
	| { readonly outcome: "failed"; readonly error: string };

/**
 * Route one inbound channel message: answer the session's pending question when there is one,
 * otherwise steer/prompt the session with the text as a new instruction.
 */
export async function routeInboundChannelMessage(
	message: AgentChannelMessage,
	deps: SideChannelDeps,
): Promise<SideChannelOutcome> {
	const sessionId = message.sessionId;
	if (sessionId === undefined || sessionId.length === 0) {
		return { outcome: "failed", error: "no target session" };
	}
	const text = message.text.trim();
	if (text.length === 0) {
		return { outcome: "failed", error: "empty message" };
	}
	if (await deps.hasPendingQuestion(sessionId)) {
		const result = await deps.answerQuestion(sessionId, text);
		return result.ok ? { outcome: "answered" } : { outcome: "failed", error: result.error ?? "answer failed" };
	}
	const result = await deps.steer(sessionId, text);
	return result.accepted ? { outcome: "steered" } : { outcome: "failed", error: result.error ?? "steer failed" };
}

/** A transport adapter (QQ bot, Telegram, local bridge, …). `send` must not throw. */
export interface AgentChannelAdapter {
	readonly id: string;
	/** Begin listening. `onMessage` feeds `routeInboundChannelMessage`. */
	start(onMessage: (message: AgentChannelMessage) => void): void | Promise<void>;
	/** Deliver an agent event to the IM side. */
	send(event: AgentNotification): void;
	stop?(): void;
}

const adapters = new Map<string, AgentChannelAdapter>();
const unsubscribers = new Map<string, () => void>();

/**
 * Register a channel adapter. Inbound messages go to `routeInboundChannelMessage` (wired by the
 * caller through {@link startChannelAdapters}); outbound agent events are forwarded automatically.
 */
export function registerChannelAdapter(
	adapter: AgentChannelAdapter,
	onMessage?: (message: AgentChannelMessage) => void,
): () => void {
	unregisterChannelAdapter(adapter.id);
	adapters.set(adapter.id, adapter);
	// Fan agent events (needs-input / finished / failed) into this adapter.
	unsubscribers.set(
		adapter.id,
		registerNotificationChannel((event) => {
			try {
				adapter.send(event);
			} catch {
				// a misbehaving adapter must never break the caller
			}
		}),
	);
	if (onMessage) void adapter.start(onMessage);
	return () => unregisterChannelAdapter(adapter.id);
}

export function unregisterChannelAdapter(id: string): void {
	unsubscribers.get(id)?.();
	unsubscribers.delete(id);
	const adapter = adapters.get(id);
	adapters.delete(id);
	adapter?.stop?.();
}

export function listChannelAdapters(): string[] {
	return [...adapters.keys()];
}

/** Start every adapters' inbound listener with a shared message handler. */
export function startChannelAdapters(onMessage: (message: AgentChannelMessage) => void): void {
	for (const adapter of adapters.values()) void adapter.start(onMessage);
}

export function stopChannelAdapters(): void {
	for (const id of [...adapters.keys()]) unregisterChannelAdapter(id);
}
