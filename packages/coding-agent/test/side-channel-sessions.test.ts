import { describe, expect, it, vi } from "vitest";
import { routeInboundChannelMessage } from "../src/experimental/side-channel.ts";
import {
	createSessionChannelOpener,
	createSideChannelDeps,
	type SessionServiceSource,
} from "../src/experimental/side-channel-sessions.ts";

describe("createSideChannelDeps", () => {
	it("forwards each effect to the session's services", async () => {
		const open = vi.fn(() => ({
			hasPendingQuestion: async () => true,
			answer: async (text: string) => ({ ok: text === "yes" }),
			steer: async (text: string) => ({ accepted: text === "go" }),
		}));
		const deps = createSideChannelDeps(open);
		expect(await deps.hasPendingQuestion("s1")).toBe(true);
		expect(await deps.answerQuestion("s1", "yes")).toEqual({ ok: true });
		expect(await deps.steer("s1", "go")).toEqual({ accepted: true });
		expect(open).toHaveBeenCalledWith("s1");
	});

	it("drives the router: answers when a question is pending, otherwise steers", async () => {
		const pending = { value: true };
		const answer = vi.fn(async () => ({ ok: true }));
		const steer = vi.fn(async () => ({ accepted: true }));
		const deps = createSideChannelDeps(() => ({
			hasPendingQuestion: async () => pending.value,
			answer,
			steer,
		}));

		expect(await routeInboundChannelMessage({ channel: "im", sessionId: "s1", text: "yes" }, deps)).toEqual({
			outcome: "answered",
		});
		expect(answer).toHaveBeenCalledWith("yes");

		pending.value = false;
		expect(await routeInboundChannelMessage({ channel: "im", sessionId: "s1", text: "restart it" }, deps)).toEqual({
			outcome: "steered",
		});
		expect(steer).toHaveBeenCalledWith("restart it");
	});
});

describe("createSessionChannelOpener", () => {
	const keys = { Questions: "Q", AgentController: "AC" };

	function source(
		questions: { answer: (text: string) => Promise<{ ok: boolean; error?: string }> },
		controller: {
			steer: (r: {
				message: string;
				images: null;
			}) => Promise<{ accepted: boolean; error?: { message: string } | null }>;
		},
		openSpy?: (options: unknown) => void,
	): SessionServiceSource {
		return {
			open(options) {
				openSpy?.(options);
				return {
					use: <T>(service: unknown): T => (service === "Q" ? questions : controller) as T,
				};
			},
		};
	}

	it("opens the target session and answers a pending question", async () => {
		const openSpy = vi.fn();
		const answer = vi.fn(async () => ({ ok: true }));
		const opened = createSessionChannelOpener(
			source({ answer }, { steer: async () => ({ accepted: true }) }, openSpy),
			keys,
			async () => true,
		);

		const deps = createSideChannelDeps(opened);
		expect(await routeInboundChannelMessage({ channel: "im", sessionId: "s7", text: "yes" }, deps)).toEqual({
			outcome: "answered",
		});
		expect(openSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s7" }));
		expect(answer).toHaveBeenCalledWith("yes");
	});

	it("steers the session with a plain prompt when no question is pending", async () => {
		const steer = vi.fn(async () => ({ accepted: true, error: null }));
		const opened = createSessionChannelOpener(
			source({ answer: async () => ({ ok: true }) }, { steer }),
			keys,
			async () => false,
		);

		const deps = createSideChannelDeps(opened);
		expect(await routeInboundChannelMessage({ channel: "im", sessionId: "s7", text: "go" }, deps)).toEqual({
			outcome: "steered",
		});
		expect(steer).toHaveBeenCalledWith({ message: "go", images: null });
	});

	it("surfaces a steer failure from the controller", async () => {
		const steer = vi.fn(async () => ({ accepted: false, error: { message: "busy" } }));
		const opened = createSessionChannelOpener(
			source({ answer: async () => ({ ok: true }) }, { steer }),
			keys,
			async () => false,
		);

		const deps = createSideChannelDeps(opened);
		expect(await routeInboundChannelMessage({ channel: "im", sessionId: "s7", text: "go" }, deps)).toEqual({
			outcome: "failed",
			error: "busy",
		});
	});
});
