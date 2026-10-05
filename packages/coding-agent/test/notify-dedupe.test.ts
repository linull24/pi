import { describe, expect, it } from "vitest";
import { emitAgentNotification, registerNotificationChannel } from "../src/experimental/notify.ts";

describe("agent notification dedupe", () => {
	it("drops a repeated (kind, session) inside the window, and PI_NOTIFY_DEDUPE_MS=0 disables it", () => {
		const seen: string[] = [];
		const off = registerNotificationChannel((event) => seen.push(`${event.kind}:${event.sessionId}`));
		try {
			emitAgentNotification({ kind: "finished", title: "t", message: "m", sessionId: "s-x" });
			emitAgentNotification({ kind: "finished", title: "t", message: "m", sessionId: "s-x" });
			expect(seen).toEqual(["finished:s-x"]);

			process.env.PI_NOTIFY_DEDUPE_MS = "0";
			emitAgentNotification({ kind: "finished", title: "t", message: "m", sessionId: "s-x" });
			expect(seen).toHaveLength(2);
		} finally {
			delete process.env.PI_NOTIFY_DEDUPE_MS;
			off();
		}
	});
});
