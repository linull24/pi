/**
 * QQ bot channel adapter.
 *
 * Implements the official QQ bot protocol (mirrors hermes' adapter) as a transport for the side
 * channel: inbound `C2C_MESSAGE_CREATE` events become `AgentChannelMessage`s, and agent
 * notifications are sent back with `POST /v2/users/{openid}/messages`.
 *
 * Credentials are read at request time (`QQ_APP_ID` / `QQ_CLIENT_SECRET`) and never logged.
 * Pure request/parse helpers are exported so the protocol can be unit-tested without a network.
 */

import type { AgentNotification } from "../notify.ts";
import type { AgentChannelAdapter, AgentChannelMessage } from "../side-channel.ts";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE = "https://api.sgroup.qq.com";
/** C2C group-at messages | public guild messages | direct message | interaction. */
const INTENTS = (1 << 25) | (1 << 30) | (1 << 12) | (1 << 26);
const MSG_TYPE_TEXT = 0;
const MAX_MESSAGE_LENGTH = 4000;

/** Build the access-token request for the QQ bot REST API. */
export function buildAccessTokenRequest(appId: string, clientSecret: string): { url: string; body: string } {
	return { url: TOKEN_URL, body: JSON.stringify({ appId, clientSecret }) };
}

/** Extract a C2C text message from a gateway payload, or undefined for anything else. */
export function parseC2CMessage(payload: unknown): { openid: string; text: string; messageId: string } | undefined {
	if (payload === null || typeof payload !== "object") return undefined;
	const event = payload as { t?: unknown; d?: unknown };
	if (event.t !== "C2C_MESSAGE_CREATE") return undefined;
	const d = event.d as { id?: unknown; content?: unknown; author?: { user_openid?: unknown } } | undefined;
	if (d === undefined || typeof d !== "object") return undefined;
	const openid = d.author?.user_openid;
	const text = typeof d.content === "string" ? d.content.trim() : "";
	if (typeof openid !== "string" || openid.length === 0 || text.length === 0) return undefined;
	return { openid, text, messageId: typeof d.id === "string" ? d.id : "" };
}

/** Build the outbound text message request for a C2C user. */
export function buildC2CReply(openid: string, text: string, msgSeq: number): { path: string; body: string } {
	return {
		path: `/v2/users/${openid}/messages`,
		body: JSON.stringify({ content: text.slice(0, MAX_MESSAGE_LENGTH), msg_type: MSG_TYPE_TEXT, msg_seq: msgSeq }),
	};
}

export interface QqBotOptions {
	readonly appId: string;
	readonly clientSecret: string;
	/** Map an IM conversation (openid) to a pi session id. */
	resolveSession(openid: string): string | undefined;
	/** Where agent notifications go when no conversation is paired yet. */
	readonly defaultOpenid?: string;
	log?(message: string): void;
}

interface WsLike {
	send(data: string): void;
	close(): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
}

/**
 * A QQ bot channel adapter. `start` connects the gateway WebSocket and feeds inbound messages to the
 * handler; `send` posts an agent notification back to the paired conversation.
 */
export function createQqBotAdapter(options: QqBotOptions): AgentChannelAdapter {
	const log = options.log ?? (() => {});
	let token: string | undefined;
	let tokenExpiresAt = 0;
	let ws: WsLike | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	let seq: number | undefined;
	let sessionId: string | undefined;
	let msgSeq = 0;
	let onMessage: ((message: AgentChannelMessage) => void) | undefined;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let stopped = false;

	const ensureToken = async (): Promise<string> => {
		if (token !== undefined && Date.now() < tokenExpiresAt) return token;
		const request = buildAccessTokenRequest(options.appId, options.clientSecret);
		const response = await fetch(request.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: request.body,
		});
		const data = (await response.json()) as { access_token?: string; expires_in?: number };
		if (typeof data.access_token !== "string")
			throw new Error(`QQ token response missing access_token (${response.status})`);
		token = data.access_token;
		tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000 - 60_000;
		log("QQ access token refreshed");
		return token;
	};

	const api = async (method: string, path: string, body?: string): Promise<unknown> => {
		const current = await ensureToken();
		const response = await fetch(`${API_BASE}${path}`, {
			method,
			headers: { authorization: `QQBot ${current}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body }),
		});
		if (!response.ok) throw new Error(`QQ ${method} ${path} -> ${response.status}`);
		return response.json();
	};

	const sendRaw = (payload: unknown): void => {
		try {
			ws?.send(JSON.stringify(payload));
		} catch {
			// a closed socket is handled by the reconnect loop
		}
	};

	const connect = async (): Promise<void> => {
		if (stopped) return;
		const current = await ensureToken();
		const gateway = (await api("GET", "/gateway")) as { url?: string };
		const url = typeof gateway.url === "string" ? gateway.url : undefined;
		if (url === undefined) throw new Error("QQ gateway response missing url");
		const socket = new WebSocket(url) as unknown as WsLike;
		ws = socket;
		socket.addEventListener("message", (raw) => {
			let payload: { op?: number; d?: unknown; t?: string; s?: number };
			try {
				payload = JSON.parse(String((raw as { data?: unknown }).data ?? "")) as typeof payload;
			} catch {
				return;
			}
			if (typeof payload.s === "number") seq = payload.s;
			if (payload.op === 10) {
				const hello = (payload.d ?? {}) as { heartbeat_interval?: number };
				const interval = Math.max(5_000, Math.floor((hello.heartbeat_interval ?? 30_000) * 0.8));
				heartbeat = setInterval(() => sendRaw({ op: 1, d: seq ?? null }), interval);
				if (sessionId === undefined) {
					sendRaw({
						op: 2,
						d: {
							token: `QQBot ${current}`,
							intents: INTENTS,
							shard: [0, 1],
							properties: { $os: "node", $browser: "pi-captain", $device: "pi-captain" },
						},
					});
				} else {
					sendRaw({ op: 6, d: { token: `QQBot ${current}`, session_id: sessionId, seq } });
				}
				return;
			}
			if (payload.op === 0 && payload.t === "READY") {
				sessionId = (payload.d as { session_id?: string }).session_id;
				log(`QQ gateway ready (session ${sessionId ?? "?"})`);
				return;
			}
			const message = parseC2CMessage(payload);
			if (message !== undefined) {
				onMessage?.({
					channel: "qq",
					sessionId: options.resolveSession(message.openid),
					text: message.text,
					from: message.openid,
				});
			}
		});
		socket.addEventListener("close", () => {
			if (heartbeat !== undefined) clearInterval(heartbeat);
			heartbeat = undefined;
			if (!stopped)
				reconnectTimer = setTimeout(
					() => void connect().catch((error) => log(`QQ reconnect failed: ${String(error)}`)),
					5_000,
				);
		});
		socket.addEventListener("error", () => log("QQ gateway socket error"));
	};

	return {
		id: "qq",
		start(handler) {
			onMessage = handler;
			void connect().catch((error) => log(`QQ connect failed: ${String(error)}`));
		},
		send(notification: AgentNotification) {
			const openid = options.defaultOpenid;
			if (openid === undefined || openid.length === 0) return;
			try {
				if (heartbeat === undefined) {
					log(`QQ not connected; dropped ${notification.kind}`);
					return;
				}
				msgSeq += 1;
				const reply = buildC2CReply(openid, `${notification.title}\n${notification.message}`, msgSeq);
				void api("POST", reply.path, reply.body).then(
					() => log(`QQ sent ${notification.kind}`),
					(error) => log(`QQ send failed: ${String(error)}`),
				);
			} catch {
				// a failed send must never break the emitter
			}
		},
		stop() {
			stopped = true;
			if (heartbeat !== undefined) clearInterval(heartbeat);
			if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
			try {
				ws?.close();
			} catch {
				// already closed
			}
		},
	};
}
