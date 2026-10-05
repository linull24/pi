/**
 * Generic agent-event notification interface.
 *
 * Events are structured (`kind` + payload); delivery is pluggable. The default channel is the
 * community `node-notifier` (macOS Notification Center + Linux/XDG). Future channels can fan the
 * same events into hermes / IM apps (Telegram, Slack, …), or drive a state machine, without
 * changing the call sites.
 */

import notifier from "node-notifier";

export type AgentEventKind = "needs-input" | "finished" | "failed";

export interface AgentNotification {
	readonly kind: AgentEventKind;
	readonly title: string;
	readonly message: string;
	/** Session the event belongs to, when known. */
	readonly sessionId?: string;
	/** Working directory of the session, when known. */
	readonly cwd?: string;
}

/** A delivery channel. Must not throw; the emitter swallows channel errors. */
export type NotificationChannel = (event: AgentNotification) => void;

const channels = new Set<NotificationChannel>();

/** Register a delivery channel (desktop, IM, hermes, …). Returns an unsubscribe function. */
export function registerNotificationChannel(channel: NotificationChannel): () => void {
	channels.add(channel);
	return () => channels.delete(channel);
}

/** Emit a structured agent event to every registered channel. */
export function emitAgentNotification(event: AgentNotification): void {
	for (const channel of channels) {
		try {
			channel(event);
		} catch {
			// a misbehaving channel must never break the caller
		}
	}
}

/** Default desktop channel: the community node-notifier library (macOS + Linux/XDG). */
function desktopChannel(event: AgentNotification): void {
	try {
		notifier.notify({ title: event.title, message: event.message.slice(0, 200) });
	} catch {
		// best-effort
	}
}

registerNotificationChannel(desktopChannel);
