/**
 * Free-model selection: **acceptable** comparison, not a fallback chain.
 *
 * A candidate is described by its *quality* and its *budget type* (how money/quota behaves), and an
 * objective says what the current turn needs: a quality `floor`, a cost `ceiling`, and whether to
 * prefer cost or quality. Selection is then:
 *
 *     acceptable(c) = available(c) && quality(c) >= floor && cost(c) <= ceiling
 *
 * and among acceptable candidates we take the one the objective prefers. If **none** is acceptable
 * the result says so and marks `escalate` — the caller must decide explicitly to raise the ceiling or
 * lower the floor. `rubbish` is a hard floor: it is never selected.
 *
 * Rationale (docs/free-model-tiers.md): OpenRouter is metered and expensive — last resort; a
 * subscription is `subscription-flat` (use it, but not to excess); DeepSeek's daily-free is a
 * *source* with its own quota; rubbish models make things worse.
 */

export type Quality = "sota" | "strong" | "usable" | "weak" | "rubbish";

export const QUALITY_RANK: Record<Quality, number> = { rubbish: 0, weak: 1, usable: 2, strong: 3, sota: 4 };

/** How a provider's money/quota behaves (the user's taxonomy). */
export type BudgetType =
	| "daily-free"
	| "one-time-free"
	| "metered"
	| "subscription-flat"
	| "subscription-overage"
	| "shared-pool"
	| "own-relay";

/** Effective cost of one more token. */
export type CostClass = "zero" | "low" | "high";

/** The cost a budget type implies unless the registry says otherwise. */
export function costOfBudget(budget: BudgetType): CostClass {
	switch (budget) {
		case "own-relay":
		case "subscription-flat":
		case "daily-free":
		case "one-time-free":
		case "shared-pool":
		case "subscription-overage":
			return "zero";
		case "metered":
			return "high";
	}
}

/** Whether the source should be rationed (subscription-flat and own-relay should not). */
export function shouldConserve(budget: BudgetType): boolean {
	return budget !== "subscription-flat" && budget !== "own-relay";
}

export interface Candidate {
	readonly provider: string;
	readonly model: string;
	/** Source identity — e.g. a research-institute program is a different source from the official API. */
	readonly source: string;
	readonly quality: Quality;
	readonly budget: BudgetType;
	/** Explicit cost class; defaults to {@link costOfBudget}. */
	readonly cost?: CostClass;
	/** Available right now? Defaults to true; set false when out of quota / blocked / 429. */
	readonly available?: boolean;
	/** Cache-read pricing is cheap for this source (affects keep-vs-switch, not acceptance here). */
	readonly cacheReadCheap?: boolean;
}

export type CostCeiling = "free" | "cheap" | "any";

export interface Objective {
	readonly floor: Quality;
	readonly ceiling: CostCeiling;
	readonly prefer: "cost" | "quality";
}

const CEILING_RANK: Record<CostCeiling, number> = { free: 0, cheap: 1, any: 2 };
const COST_RANK: Record<CostClass, number> = { zero: 0, low: 1, high: 2 };

export function costClassOf(candidate: Candidate): CostClass {
	return candidate.cost ?? costOfBudget(candidate.budget);
}

/** Whether a candidate may be used for this objective at all. */
export function acceptable(candidate: Candidate, objective: Objective): boolean {
	if (candidate.available === false) return false;
	// `rubbish` is a hard floor: it may make things worse, so it is never acceptable.
	if (candidate.quality === "rubbish") return false;
	if (QUALITY_RANK[candidate.quality] < QUALITY_RANK[objective.floor]) return false;
	return COST_RANK[costClassOf(candidate)] <= CEILING_RANK[objective.ceiling];
}

export interface Selection {
	readonly chosen?: Candidate;
	/** Why nothing was chosen, when `chosen` is undefined. */
	readonly reason: string;
	/** True when no candidate was acceptable: raise the ceiling or lower the floor explicitly. */
	readonly escalate: boolean;
	readonly acceptableCount: number;
}

/** Pick the best acceptable candidate for the objective. */
export function selectCandidate(candidates: readonly Candidate[], objective: Objective): Selection {
	const ok = candidates.filter((candidate) => acceptable(candidate, objective));
	if (ok.length === 0) {
		return {
			reason: `no acceptable candidate (floor=${objective.floor}, ceiling=${objective.ceiling})`,
			escalate: true,
			acceptableCount: 0,
		};
	}
	const sorted = [...ok].sort((left, right) => {
		const leftCost = COST_RANK[costClassOf(left)];
		const rightCost = COST_RANK[costClassOf(right)];
		const leftQuality = QUALITY_RANK[left.quality];
		const rightQuality = QUALITY_RANK[right.quality];
		if (objective.prefer === "cost") {
			if (leftCost !== rightCost) return leftCost - rightCost;
			return rightQuality - leftQuality;
		}
		if (leftQuality !== rightQuality) return rightQuality - leftQuality;
		return leftCost - rightCost;
	});
	return { chosen: sorted[0], reason: `prefer ${objective.prefer}`, escalate: false, acceptableCount: ok.length };
}

/** Objective presets for the roles. */
export const OBJECTIVES = {
	/** Light/assist work: cheapest that is not rubbish. */
	cheap: { floor: "weak", ceiling: "free", prefer: "cost" } as Objective,
	/** Routine work: usable quality, free if possible. */
	routine: { floor: "usable", ceiling: "free", prefer: "cost" } as Objective,
	/** Real work: it must work, cost is secondary. */
	mustWork: { floor: "strong", ceiling: "any", prefer: "quality" } as Objective,
} as const;

// ── Registry (data → candidates) ────────────────────────────────────────────────────────────────

export interface RegistrySource {
	readonly provider: string;
	readonly budget: BudgetType;
	readonly quality: Quality;
	readonly cost?: CostClass;
	readonly available?: boolean;
	readonly softCap?: boolean;
	readonly quota?: { readonly period: string; readonly amount?: string; readonly left?: number };
	readonly cache?: { readonly cheap?: boolean };
	readonly note?: string;
}

export interface RegistryModel {
	readonly provider: string;
	readonly model: string;
	readonly source?: string;
	readonly quality?: Quality;
	readonly budget?: BudgetType;
	readonly cost?: CostClass;
	readonly available?: boolean;
}

export interface Registry {
	readonly sources: Readonly<Record<string, RegistrySource>>;
	readonly models?: readonly RegistryModel[];
	readonly objectives?: Readonly<Record<string, Objective>>;
}

/**
 * Flatten a registry into candidates. A model inherits its source's defaults (looked up by the
 * registry key that names the provider, else by the provider itself) and may override them.
 */
export function registryCandidates(registry: Registry): Candidate[] {
	// Provider -> source is only a *default*: several sources can share one provider (the official
	// API vs a research-institute program), so the first declaration wins and an exact source key or
	// an explicit model.source always takes precedence.
	const byProvider = new Map<string, RegistrySource>();
	for (const source of Object.values(registry.sources)) {
		if (!byProvider.has(source.provider)) byProvider.set(source.provider, source);
	}
	const out: Candidate[] = [];
	for (const model of registry.models ?? []) {
		const source =
			(model.source === undefined ? undefined : (registry.sources[model.source] ?? byProvider.get(model.source))) ??
			registry.sources[model.provider] ??
			byProvider.get(model.provider);
		if (source === undefined) continue;
		out.push({
			provider: model.provider,
			model: model.model,
			source: model.source ?? source.provider,
			quality: model.quality ?? source.quality,
			budget: model.budget ?? source.budget,
			...((model.cost ?? source.cost) === undefined ? {} : { cost: (model.cost ?? source.cost) as CostClass }),
			available: model.available ?? source.available,
			...(source.cache?.cheap === undefined ? {} : { cacheReadCheap: source.cache.cheap }),
		});
	}
	return out;
}

export function objectiveOf(registry: Registry, role: string, fallback: Objective = OBJECTIVES.routine): Objective {
	return registry.objectives?.[role] ?? fallback;
}
