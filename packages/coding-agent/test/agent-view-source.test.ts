import { describe, expect, it } from "vitest";
import {
	captainEntry,
	listAgentViewSources,
	registerAgentViewSource,
	renameAgentViewRow,
} from "../src/experimental/agent-view-sources.ts";

describe("Agent View C source", () => {
	it('tags the captain entry as origin "c" with a stable default name', () => {
		const entry = captainEntry({ sessionId: "captain" });
		expect(entry.origin).toBe("c");
		expect(entry.name).toBe("captain");
		expect(entry.sessionId).toBe("captain");
	});

	it("honours overrides (rename later) while keeping the C origin", () => {
		const entry = captainEntry({ sessionId: "captain", name: "helmsman", state: "working" });
		expect(entry.name).toBe("helmsman");
		expect(entry.state).toBe("working");
		expect(entry.origin).toBe("c");
	});

	it("registers and unregisters a C source", () => {
		const source = { id: "c-test", label: "captain", list: () => [captainEntry({ sessionId: "captain" })] };
		const off = registerAgentViewSource(source);
		expect(listAgentViewSources().some((s) => s.id === "c-test")).toBe(true);
		off();
		expect(listAgentViewSources().some((s) => s.id === "c-test")).toBe(false);
	});

	it("unregistering a replaced source leaves the newer one in place", () => {
		const first = { id: "c-dup", label: "captain", list: () => [] };
		const second = { id: "c-dup", label: "captain-2", list: () => [] };
		const offFirst = registerAgentViewSource(first);
		registerAgentViewSource(second);
		offFirst();
		expect(
			listAgentViewSources()
				.filter((s) => s.id === "c-dup")
				.map((s) => s.label),
		).toEqual(["captain-2"]);
	});
	it("renames a row through the owning source (captain is renameable)", () => {
		const calls: Array<[string, string]> = [];
		const off = registerAgentViewSource({
			id: "c-rename",
			label: "captain",
			list: () => [captainEntry({ sessionId: "captain" })],
			rename: (sessionId, name) => {
				calls.push([sessionId, name]);
				return sessionId === "captain";
			},
		});
		try {
			expect(renameAgentViewRow("captain", "helmsman")).toBe(true);
			expect(calls).toEqual([["captain", "helmsman"]]);
			expect(renameAgentViewRow("someone-else", "x")).toBe(false);
		} finally {
			off();
		}
	});

	it("a source without rename support cannot be renamed", () => {
		const off = registerAgentViewSource({ id: "c-norename", label: "captain", list: () => [] });
		try {
			expect(renameAgentViewRow("captain", "x")).toBe(false);
		} finally {
			off();
		}
	});
});
