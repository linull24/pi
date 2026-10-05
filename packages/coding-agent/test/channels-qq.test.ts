import { describe, expect, it } from "vitest";
import { buildAccessTokenRequest, buildC2CReply, parseC2CMessage } from "../src/experimental/channels/qq.ts";

describe("QQ bot protocol helpers", () => {
	it("builds the access-token request", () => {
		const request = buildAccessTokenRequest("app-1", "secret-1");
		expect(request.url).toBe("https://bots.qq.com/app/getAppAccessToken");
		expect(JSON.parse(request.body)).toEqual({ appId: "app-1", clientSecret: "secret-1" });
	});

	it("parses a C2C text message", () => {
		const payload = {
			op: 0,
			t: "C2C_MESSAGE_CREATE",
			d: { id: "msg-1", content: "  redeploy please  ", author: { user_openid: "openid-1" } },
		};
		expect(parseC2CMessage(payload)).toEqual({ openid: "openid-1", text: "redeploy please", messageId: "msg-1" });
	});

	it("ignores other events, empty content, and missing authors", () => {
		expect(parseC2CMessage({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: {} })).toBeUndefined();
		expect(parseC2CMessage({ op: 0, t: "C2C_MESSAGE_CREATE", d: { content: "hi", author: {} } })).toBeUndefined();
		expect(
			parseC2CMessage({ op: 0, t: "C2C_MESSAGE_CREATE", d: { content: "   ", author: { user_openid: "o" } } }),
		).toBeUndefined();
		expect(parseC2CMessage({ op: 10, d: { heartbeat_interval: 30000 } })).toBeUndefined();
	});

	it("builds a C2C reply body", () => {
		const reply = buildC2CReply("openid-1", "hello", 3);
		expect(reply.path).toBe("/v2/users/openid-1/messages");
		expect(JSON.parse(reply.body)).toEqual({ content: "hello", msg_type: 0, msg_seq: 3 });
	});
});
