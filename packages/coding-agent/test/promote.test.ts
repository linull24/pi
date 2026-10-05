import { describe, expect, it, vi } from "vitest";
import {
	type AuthorizationProvider,
	checkNoPollution,
	type Delta,
	type PromoteDeps,
	promote,
} from "../src/experimental/promote.ts";

const delta: Delta = {
	ref: "playground/qq-channel",
	scope: [".pi/extensions/channels"],
	paths: [".pi/extensions/channels/index.ts", ".pi/extensions/channels/qq.ts"],
	riskClass: "low",
};

function deps(overrides: Partial<PromoteDeps> = {}): PromoteDeps {
	return {
		resolveTier: () => "T3-agent",
		providers: [],
		apply: async () => {},
		verify: async () => ({ ok: true }),
		rollback: async () => {},
		...overrides,
	};
}

const provider = (
	tier: AuthorizationProvider["tier"],
	decision: Awaited<ReturnType<AuthorizationProvider["authorize"]>>,
): AuthorizationProvider => ({ tier, authorize: async () => decision });

describe("checkNoPollution", () => {
	it("accepts a delta inside an allowed surface", () => {
		expect(checkNoPollution(delta)).toEqual({ ok: true });
	});

	it("rejects a declared scope outside the allowed surfaces", () => {
		const result = checkNoPollution({ ...delta, scope: ["~/Documents/other"], paths: [] });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("outside the allowed surfaces");
	});

	it("rejects a path outside the declared scope", () => {
		const result = checkNoPollution({ ...delta, paths: [".pi/extensions/other/index.ts"] });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("outside the declared scope");
	});

	it("rejects forbidden paths even inside an allowed surface (credentials, controls, persistence)", () => {
		for (const path of [
			".pi/config/auth.json",
			".pi/extensions/x/pi-automode/rules.ts",
			".pi/config/settings.json",
		]) {
			const result = checkNoPollution({ ...delta, scope: [".pi/config", ".pi/extensions/x"], paths: [path] });
			expect(result.ok, path).toBe(false);
			expect(result.reason).toContain("forbidden");
		}
	});
});

describe("promote", () => {
	it("applies when the resolved tier's provider approves", async () => {
		const apply = vi.fn(async () => {});
		const result = await promote(delta, deps({ providers: [provider("T3-agent", { approved: true })], apply }));
		expect(result).toEqual({ outcome: "applied", tier: "T3-agent" });
		expect(apply).toHaveBeenCalledOnce();
	});

	it("rejects pollution before any authorization or apply", async () => {
		const authorize = vi.fn();
		const apply = vi.fn(async () => {});
		const result = await promote(
			{ ...delta, paths: [".pi/config/auth.json"] },
			deps({ providers: [{ tier: "T3-agent", authorize }], apply }),
		);
		expect(result.outcome).toBe("polluted");
		expect(authorize).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});

	it("resolves the tier on A's side (C never declares it)", async () => {
		const resolveTier = vi.fn(() => "T1-user" as const);
		const result = await promote(
			delta,
			deps({
				resolveTier,
				providers: [provider("T1-user", { approved: true }), provider("T3-agent", { approved: true })],
			}),
		);
		expect(resolveTier).toHaveBeenCalledWith(delta);
		expect(result).toEqual({ outcome: "applied", tier: "T1-user" });
	});

	it("reports pending (user not answered) and does not apply", async () => {
		const apply = vi.fn(async () => {});
		const result = await promote(
			delta,
			deps({
				resolveTier: () => "T1-user",
				providers: [provider("T1-user", { pending: true, reason: "awaiting IM reply" })],
				apply,
			}),
		);
		expect(result).toEqual({ outcome: "pending", reason: "awaiting IM reply" });
		expect(apply).not.toHaveBeenCalled();
	});

	it("reports unauthorized when denied", async () => {
		const result = await promote(
			delta,
			deps({
				resolveTier: () => "T1-user",
				providers: [provider("T1-user", { approved: false, reason: "denied" })],
			}),
		);
		expect(result).toEqual({ outcome: "unauthorized", reason: "denied" });
	});

	it("requires a provider for the resolved tier", async () => {
		const result = await promote(delta, deps({ resolveTier: () => "T1-user" }));
		expect(result).toEqual({ outcome: "unauthorized", reason: "no authorization provider for T1-user" });
	});

	it("rolls back when A/B verification fails after A applied the diff", async () => {
		const rollback = vi.fn(async () => {});
		const result = await promote(
			delta,
			deps({
				providers: [provider("T3-agent", { approved: true })],
				verify: async () => ({ ok: false, reason: "tests failed" }),
				rollback,
			}),
		);
		expect(result).toEqual({ outcome: "rolled-back", reason: "tests failed" });
		expect(rollback).toHaveBeenCalledOnce();
	});
});
