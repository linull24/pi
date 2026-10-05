import { describe, expect, it, vi } from "vitest";
import {
	CAPTAIN_DEFAULT_MODEL,
	captainConfigFromEnv,
	startCaptain,
	startCaptainStateWatch,
	transitionEvent,
} from "../src/experimental/captain.ts";
import { emitAgentNotification } from "../src/experimental/notify.ts";
import type { AgentChannelAdapter, AgentChannelMessage, SideChannelDeps } from "../src/experimental/side-channel.ts";

function deps(overrides: Partial<SideChannelDeps> = {}): SideChannelDeps {
	return {
		hasPendingQuestion: async () => false,
		answerQuestion: async () => ({ ok: true }),
		steer: async () => ({ accepted: true }),
		...overrides,
	};
}

/** A fake adapter that records what it sends and lets the test push an inbound message. */
function fakeAdapter(): { adapter: AgentChannelAdapter; sent: unknown[]; push(message: AgentChannelMessage): void } {
	let handler: ((message: AgentChannelMessage) => void) | undefined;
	const sent: unknown[] = [];
	return {
		adapter: {
			id: "qq",
			start: (onMessage) => {
				handler = onMessage;
			},
			send: (event) => sent.push(event),
		},
		sent,
		push: (message) => handler?.(message),
	};
}

describe("captainConfigFromEnv", () => {
	it("returns undefined without QQ credentials", () => {
		expect(captainConfigFromEnv({}, () => undefined)).toBeUndefined();
		expect(captainConfigFromEnv({ QQ_APP_ID: "a" }, () => undefined)).toBeUndefined();
	});

	it("defaults the model to agnes and reads the home channel", () => {
		const config = captainConfigFromEnv(
			{ QQ_APP_ID: "a", QQ_CLIENT_SECRET: "s", QQBOT_HOME_CHANNEL: "openid-1" },
			() => "s1",
		);
		expect(config?.model).toBe(CAPTAIN_DEFAULT_MODEL);
		expect(config?.defaultOpenid).toBe("openid-1");
		expect(config?.resolveSession("openid-1")).toBe("s1");
	});
});

describe("startCaptain", () => {
	it("routes an inbound QQ message into the session and forwards agent events to QQ", async () => {
		const steer = vi.fn(async () => ({ accepted: true }));
		const fake = fakeAdapter();
		const stop = startCaptain(
			{ appId: "a", clientSecret: "s", resolveSession: () => "s1" },
			{ sideChannel: deps({ steer }) },
			() => fake.adapter,
		);
		try {
			fake.push({ channel: "qq", sessionId: "s1", text: "restart the gateway" });
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(steer).toHaveBeenCalledWith("s1", "restart the gateway");

			emitAgentNotification({ kind: "needs-input", title: "pi", message: "pick one" });
			expect(fake.sent).toEqual([{ kind: "needs-input", title: "pi", message: "pick one" }]);
		} finally {
			stop();
		}
	});

	it("answers a pending question instead of steering", async () => {
		const answer = vi.fn(async () => ({ ok: true }));
		const steer = vi.fn(async () => ({ accepted: true }));
		const fake = fakeAdapter();
		const stop = startCaptain(
			{ appId: "a", clientSecret: "s", resolveSession: () => "s1" },
			{ sideChannel: deps({ hasPendingQuestion: async () => true, answerQuestion: answer, steer }) },
			() => fake.adapter,
		);
		try {
			fake.push({ channel: "qq", sessionId: "s1", text: "yes" });
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(answer).toHaveBeenCalledWith("s1", "yes");
			expect(steer).not.toHaveBeenCalled();
		} finally {
			stop();
		}
	});
});

describe("outbound transitions", () => {
	it("maps state transitions to events", () => {
		expect(transitionEvent("working", "needs-input")).toBe("needs-input");
		expect(transitionEvent("working", "needs-instructions")).toBe("finished");
		expect(transitionEvent("working", "done")).toBe("finished");
		expect(transitionEvent("working", "failed")).toBe("failed");
		expect(transitionEvent("needs-instructions", "needs-instructions")).toBeUndefined();
		expect(transitionEvent(undefined, "needs-instructions")).toBeUndefined();
	});

	it("emits once per transition while polling", async () => {
		const seen: string[] = [];
		const states = ["needs-instructions", "working", "needs-input"];
		let i = 0;
		const stop = startCaptainStateWatch({
			readState: () => states[Math.min(i++, states.length - 1)]!,
			intervalMs: 5,
			onEvent: (kind) => seen.push(kind),
		});
		await new Promise((resolve) => setTimeout(resolve, 40));
		stop();
		expect(seen).toEqual(["needs-input"]);
	});
});
