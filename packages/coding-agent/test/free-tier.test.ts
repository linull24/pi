import { describe, expect, it } from "vitest";
import {
	acceptable,
	type Candidate,
	costOfBudget,
	OBJECTIVES,
	selectCandidate,
	shouldConserve,
} from "../src/experimental/free-tier.ts";

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
	provider: "p",
	model: "m",
	source: "s",
	quality: "usable",
	budget: "daily-free",
	...over,
});

describe("budget types", () => {
	it("maps budget types to cost and conserve", () => {
		expect(costOfBudget("metered")).toBe("high");
		expect(costOfBudget("subscription-flat")).toBe("zero");
		expect(costOfBudget("own-relay")).toBe("zero");
		expect(shouldConserve("daily-free")).toBe(true);
		expect(shouldConserve("shared-pool")).toBe(true);
		expect(shouldConserve("subscription-flat")).toBe(false);
		expect(shouldConserve("own-relay")).toBe(false);
	});
});

describe("acceptable", () => {
	it("requires quality >= floor and cost <= ceiling", () => {
		expect(acceptable(candidate({ quality: "strong" }), OBJECTIVES.routine)).toBe(true);
		expect(acceptable(candidate({ quality: "weak" }), OBJECTIVES.routine)).toBe(false);
		expect(acceptable(candidate({ budget: "metered" }), OBJECTIVES.cheap)).toBe(false);
		expect(acceptable(candidate({ budget: "metered", quality: "strong" }), OBJECTIVES.mustWork)).toBe(true);
	});

	it("never accepts rubbish, even when the floor is rubbish", () => {
		expect(acceptable(candidate({ quality: "rubbish" }), { floor: "rubbish", ceiling: "any", prefer: "cost" })).toBe(
			false,
		);
	});

	it("treats an unavailable source as unacceptable (out of quota / 429)", () => {
		expect(acceptable(candidate({ available: false }), OBJECTIVES.routine)).toBe(false);
	});
});

describe("selectCandidate", () => {
	it("prefers cost inside the objective, then quality", () => {
		const metered = candidate({ provider: "openrouter", quality: "sota", budget: "metered" });
		const free = candidate({ provider: "deepseek", quality: "strong", budget: "daily-free" });
		const selection = selectCandidate([metered, free], { floor: "usable", ceiling: "any", prefer: "cost" });
		expect(selection.chosen?.provider).toBe("deepseek");
		expect(selection.escalate).toBe(false);
	});

	it("prefers quality when the objective says so", () => {
		const metered = candidate({ provider: "openrouter", quality: "sota", budget: "metered" });
		const free = candidate({ provider: "deepseek", quality: "strong", budget: "daily-free" });
		expect(selectCandidate([metered, free], OBJECTIVES.mustWork).chosen?.provider).toBe("openrouter");
	});

	it("escalates instead of silently degrading when nothing is acceptable", () => {
		// DeepSeek ran out of money; only a rubbish model and a metered one remain, ceiling=free.
		const outOfMoney = candidate({ provider: "deepseek", available: false, budget: "daily-free" });
		const rubbish = candidate({ provider: "toy", quality: "rubbish", budget: "daily-free" });
		const metered = candidate({ provider: "openrouter", quality: "strong", budget: "metered" });
		const selection = selectCandidate([outOfMoney, rubbish, metered], {
			floor: "strong",
			ceiling: "free",
			prefer: "cost",
		});
		expect(selection.chosen).toBeUndefined();
		expect(selection.escalate).toBe(true);
		expect(selection.acceptableCount).toBe(0);
	});

	it("after escalation to 'any', the metered strong model is chosen", () => {
		const metered = candidate({ provider: "openrouter", quality: "strong", budget: "metered" });
		expect(selectCandidate([metered], OBJECTIVES.mustWork).chosen?.provider).toBe("openrouter");
	});
});
