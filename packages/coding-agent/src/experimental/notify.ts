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

/** Default window in which the same (kind, session) is not notified twice. Override with PI_NOTIFY_DEDUPE_MS. */
const DEFAULT_DEDUPE_MS = 60_000;
const lastEmitted = new Map<string, number>();

function dedupeWindowMs(): number {
	const raw = process.env.PI_NOTIFY_DEDUPE_MS;
	if (raw === undefined) return DEFAULT_DEDUPE_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEDUPE_MS;
}

/**
 * Emit a structured agent event to every registered channel.
 *
 * Deduplicated per (kind, sessionId) within a window: several processes register channels and a
 * session's state can flap, which otherwise turns one event into a stream of notifications. Set
 * `PI_NOTIFY_DEDUPE_MS=0` to disable.
 */
export function emitAgentNotification(event: AgentNotification): void {
	const window = dedupeWindowMs();
	if (window > 0) {
		const key = `${event.kind}:${event.sessionId ?? ""}`;
		const now = Date.now();
		const previous = lastEmitted.get(key);
		if (previous !== undefined && now - previous < window) return;
		lastEmitted.set(key, now);
	}
	for (const channel of channels) {
		try {
			channel(event);
		} catch {
			// a misbehaving channel must never break the caller
		}
	}
}

/**
 * Default desktop channel: the community node-notifier library (macOS + Linux/XDG).
 * Disabled with `PI_NO_DESKTOP_NOTIFY=1` — a process whose job is another channel (e.g. captain, which
 * only speaks QQ) should not also pop a local notification.
 */
function desktopChannel(event: AgentNotification): void {
	if (process.env.PI_NO_DESKTOP_NOTIFY === "1") return;
	try {
		notifier.notify({ title: event.title, message: event.message.slice(0, 200) });
	} catch {
		// best-effort
	}
}

registerNotificationChannel(desktopChannel);
