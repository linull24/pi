/**
 * Promotion: handing a playground increment to the base.
 *
 * Settled design:
 * - `C = A ⊕ Δ`, where Δ is a plain **git** diff/commit on C's branch. C has no write path into A.
 * - C hands Δ to A; **A applies it** under A's own commit. C never touches A/B.
 * - Afterwards the **traditional A/B** runs unchanged (checkpoint → verify → reload). The heartbeat
 *   stays a clean resilience mechanism; promotion is not bolted onto it.
 * - Authorization is a separate axis exposed only as an **abstract provider interface**. The design
 *   deliberately has no **evidence system**: no tickets, no hash binding, no audit artifacts.
 * - **No pollution**: Δ must be a declared subset of the whitelisted surfaces. Anything else (a secret
 *   file, a safety control, a persistence mechanism, a path outside the declared scope) is rejected
 *   before any authorization is even considered.
 */

/** Authorization tiers, strongest first. */
export type AuthTier = "T1-user" | "T2-spec" | "T3-agent";

/** The increment C offers: a git ref, the surfaces it declares, and the concrete paths it touches. */
export interface Delta {
	/** Git ref (branch or commit) in C that holds the change. */
	readonly ref: string;
	/** Surfaces the delta declares; every path must live under one of these. */
	readonly scope: readonly string[];
	/** Concrete file paths the diff touches. A verifies these against the actual diff when applying. */
	readonly paths: readonly string[];
	readonly riskClass: "low" | "medium" | "high";
}

/** Surfaces a delta may declare, and patterns that are always pollution. */
export interface PollutionPolicy {
	/** Only paths under one of these surfaces may be part of a delta. */
	readonly allowedScope: readonly string[];
	/** Paths that must never appear, even inside an allowed surface. */
	readonly forbidden: readonly RegExp[];
}

/**
 * Default policy: a delta may touch pi's own extensions/config surfaces, but never credentials,
 * safety controls, or persistence mechanisms.
 */
export const DEFAULT_POLLUTION_POLICY: PollutionPolicy = {
	allowedScope: [".pi/extensions/", ".pi/config/"],
	forbidden: [
		/(^|\/)auth\.json$/,
		/(^|\/)\.env(\.|$)/,
		/(^|\/)settings\.json$/,
		/(^|\/)agent-config\.json$/,
		/(^|\/)models\.json$/,
		/(^|\/)ban-[^/]+\.json$/,
		/(^|\/)self-refine\.json$/,
		/(^|\/)heartbeat\.json$/,
		/(^|\/)pi-automode\//,
		/(^|\/)autommonitor\//,
		/(^|\/)Library\/LaunchAgents\//,
		/(^|\/)\.ssh\//,
		/(^|\/)\.aws\//,
		/(^|\/)\.codex\//,
	],
};

/** True when `child` is `parent` itself or lives under it. */
function within(child: string, parent: string): boolean {
	const prefix = parent.endsWith("/") ? parent : `${parent}/`;
	return child === parent || child.startsWith(prefix);
}

/**
 * The anti-pollution gate. Every path must live under the declared scope, the declared scope must be
 * a subset of the allowed surfaces, and no path may match a forbidden pattern.
 */
export function checkNoPollution(
	delta: Delta,
	policy: PollutionPolicy = DEFAULT_POLLUTION_POLICY,
): { readonly ok: boolean; readonly reason?: string } {
	for (const surface of delta.scope) {
		if (!policy.allowedScope.some((allowed) => within(surface, allowed) || within(allowed, surface))) {
			return { ok: false, reason: `scope "${surface}" is outside the allowed surfaces` };
		}
		// A declared surface may not itself be forbidden.
		if (policy.forbidden.some((pattern) => pattern.test(surface))) {
			return { ok: false, reason: `scope "${surface}" is a forbidden surface` };
		}
	}
	for (const path of delta.paths) {
		if (!delta.scope.some((surface) => within(path, surface))) {
			return { ok: false, reason: `path "${path}" is outside the declared scope` };
		}
		if (policy.forbidden.some((pattern) => pattern.test(path))) {
			return { ok: false, reason: `path "${path}" is forbidden (would pollute)` };
		}
	}
	return { ok: true };
}

export interface AuthorizationRequest {
	readonly delta: Delta;
	readonly tier: AuthTier;
}

export type AuthorizationDecision =
	| { readonly approved: true }
	| { readonly approved: false; readonly reason: string }
	/** A prompt was shown (T1) and the answer is still pending. */
	| { readonly pending: true; readonly reason: string };

/** An independent authorization surface (IM, a notification button, a TUI confirm, a rule). */
export interface AuthorizationProvider {
	readonly tier: AuthTier;
	authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

export interface PromoteDeps {
	/** A resolves the tier from the delta; C never declares its own requirement. */
	resolveTier(delta: Delta): AuthTier;
	/** Independent authorization surfaces. */
	readonly providers: readonly AuthorizationProvider[];
	/** Apply C's diff into A's own tree under A's own commit. */
	apply(delta: Delta): Promise<void>;
	/** The traditional A/B verification (alive + tests). */
	verify(delta: Delta): Promise<{ readonly ok: boolean; readonly reason?: string }>;
	rollback(): Promise<void>;
	/** Pollution policy override. */
	readonly pollution?: PollutionPolicy;
}

export type PromoteOutcome =
	| { readonly outcome: "applied"; readonly tier: AuthTier }
	| { readonly outcome: "polluted"; readonly reason: string }
	| { readonly outcome: "unauthorized"; readonly reason: string }
	| { readonly outcome: "pending"; readonly reason: string }
	| { readonly outcome: "rolled-back"; readonly reason: string };

/**
 * Apply C's delta to A after the no-pollution gate and tiered authorization. A applies (never C), and
 * the caller runs the traditional A/B around it.
 */
export async function promote(delta: Delta, deps: PromoteDeps): Promise<PromoteOutcome> {
	const pollution = checkNoPollution(delta, deps.pollution ?? DEFAULT_POLLUTION_POLICY);
	if (!pollution.ok) {
		return { outcome: "polluted", reason: pollution.reason ?? "pollution check failed" };
	}

	const tier = deps.resolveTier(delta);
	const provider = deps.providers.find((candidate) => candidate.tier === tier);
	if (!provider) {
		return { outcome: "unauthorized", reason: `no authorization provider for ${tier}` };
	}

	const decision = await provider.authorize({ delta, tier });
	if ("pending" in decision) {
		return { outcome: "pending", reason: decision.reason };
	}
	if (!decision.approved) {
		return { outcome: "unauthorized", reason: decision.reason };
	}

	await deps.apply(delta);
	const verified = await deps.verify(delta);
	if (!verified.ok) {
		await deps.rollback();
		return { outcome: "rolled-back", reason: verified.reason ?? "verification failed" };
	}
	return { outcome: "applied", tier };
}
