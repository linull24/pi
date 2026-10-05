import { describe, expect, it, vi } from "vitest";
import { emitAgentNotification } from "../src/experimental/notify.ts";
import {
	type AgentChannelAdapter,
	type AgentChannelMessage,
	registerChannelAdapter,
	routeInboundChannelMessage,
	type SideChannelDeps,
	stopChannelAdapters,
	unregisterChannelAdapter,
} from "../src/experimental/side-channel.ts";

function deps(overrides: Partial<SideChannelDeps> = {}): SideChannelDeps {
	return {
		hasPendingQuestion: async () => false,
		answerQuestion: async () => ({ ok: true }),
		steer: async () => ({ accepted: true }),
		...overrides,
	};
}

const message = (text: string, sessionId: string | undefined = "s1"): AgentChannelMessage => ({
	channel: "test",
	sessionId,
	text,
});

describe("routeInboundChannelMessage", () => {
	it("answers the session's pending question instead of steering", async () => {
		const answerQuestion = vi.fn(async () => ({ ok: true }));
		const steer = vi.fn(async () => ({ accepted: true }));
		const result = await routeInboundChannelMessage(
			message("yes"),
			deps({ hasPendingQuestion: async () => true, answerQuestion, steer }),
		);
		expect(result).toEqual({ outcome: "answered" });
		expect(answerQuestion).toHaveBeenCalledWith("s1", "yes");
		expect(steer).not.toHaveBeenCalled();
	});

	it("steers the session when no question is pending", async () => {
		const steer = vi.fn(async () => ({ accepted: true }));
		const result = await routeInboundChannelMessage(message("fix the gateway"), deps({ steer }));
		expect(result).toEqual({ outcome: "steered" });
		expect(steer).toHaveBeenCalledWith("s1", "fix the gateway");
	});

	it("reports failures from the underlying service", async () => {
		const result = await routeInboundChannelMessage(
			message("hi"),
			deps({
				hasPendingQuestion: async () => true,
				answerQuestion: async () => ({ ok: false, error: "no pending" }),
			}),
		);
		expect(result).toEqual({ outcome: "failed", error: "no pending" });
	});

	it("rejects messages without a session or with empty text", async () => {
		const result = await routeInboundChannelMessage({ channel: "test", sessionId: undefined, text: "hi" }, deps());
		expect(result).toEqual({
			outcome: "failed",
			error: "no target session",
		});
		expect(await routeInboundChannelMessage(message("   "), deps())).toEqual({
			outcome: "failed",
			error: "empty message",
		});
	});
});

describe("channel adapters", () => {
	it("forwards agent notifications and inbound messages", async () => {
		const sent: unknown[] = [];
		const received: AgentChannelMessage[] = [];
		const adapter: AgentChannelAdapter = {
			id: "test-adapter",
			start: (onMessage) => {
				onMessage({ channel: "test-adapter", sessionId: "s9", text: "from im" });
			},
			send: (event) => sent.push(event),
		};
		const unregister = registerChannelAdapter(adapter, (m) => received.push(m));
		try {
			emitAgentNotification({ kind: "needs-input", title: "t", message: "m" });
			expect(sent).toEqual([{ kind: "needs-input", title: "t", message: "m" }]);
			expect(received).toEqual([{ channel: "test-adapter", sessionId: "s9", text: "from im" }]);
		} finally {
			unregister();
			stopChannelAdapters();
		}
		// After unregistering, events are no longer delivered.
		emitAgentNotification({ kind: "finished", title: "t2", message: "m2" });
		expect(sent).toHaveLength(1);
	});

	it("unregistering an unknown adapter is a no-op", () => {
		expect(() => unregisterChannelAdapter("missing")).not.toThrow();
	});
});
