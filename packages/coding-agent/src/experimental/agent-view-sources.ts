/**
 * Agent View row sources.
 *
 * The Agent View lists pi's own durable sessions (origin `"pi"`) and, below a divider, rows
 * contributed by C (origin `"c"`). C is an independent, permanently running process, so the UI
 * defines **only this interface**: a C source yields its rows (today exactly one stable entry
 * point, `"captain"`). Keeping the registry in its own module means it can be imported (and tested)
 * without pulling in the whole daemon graph.
 */

/** State shown at the front of every Agent View row. */
export type AgentRowState = "working" | "needs-input" | "needs-instructions" | "finishing" | "done" | "failed";

/** Where a row comes from: pi (A) or the independent C process. */
export type AgentRowOrigin = "pi" | "c";

/** One Agent View row. */
export type AgentViewRow = {
	readonly sessionId: string;
	readonly createdAt: number;
	readonly lastActivityAt: number;
	readonly cwd: string;
	readonly title: string;
	readonly activity: string;
	readonly state: AgentRowState;
	readonly entries: number;
	readonly bytes: number;
	readonly name: string | undefined;
	readonly hasUser: boolean;
	readonly done: boolean;
	readonly question: string | undefined;
	readonly origin: AgentRowOrigin;
};

/**
 * A source of C-side rows for the Agent View. Rows it returns render below the `── captain ──`
 * divider and are never merged into pi's own session list. `list` must not throw; the caller
 * swallows errors anyway.
 */
export interface AgentViewSource {
	readonly id: string;
	/** Label shown on the divider, e.g. "captain". */
	readonly label: string;
	/** Contributed rows (a single entry point today). */
	list(): readonly AgentViewRow[];
}

const agentViewSources = new Map<string, AgentViewSource>();

/** Register a C-side source for the Agent View. Returns an unsubscribe function. */
export function registerAgentViewSource(source: AgentViewSource): () => void {
	agentViewSources.set(source.id, source);
	return () => {
		if (agentViewSources.get(source.id) === source) agentViewSources.delete(source.id);
	};
}

/** The C sources currently contributing rows, in registration order. */
export function listAgentViewSources(): readonly AgentViewSource[] {
	return [...agentViewSources.values()];
}

/**
 * Build the single, stable C entry point (`"captain"`). A C source may use this so the row is shaped
 * correctly; the name is a default and C may rename it later.
 */
export function captainEntry(overrides: Partial<AgentViewRow> & { readonly sessionId: string }): AgentViewRow {
	return {
		createdAt: Date.now(),
		lastActivityAt: Date.now(),
		cwd: "",
		title: "captain",
		activity: "",
		state: "needs-instructions",
		entries: 0,
		bytes: 0,
		name: "captain",
		hasUser: true,
		done: false,
		question: undefined,
		origin: "c",
		...overrides,
	};
}
