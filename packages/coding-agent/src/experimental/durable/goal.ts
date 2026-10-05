/**
 * Durable `pi.goal` document (session scope).
 *
 * The goal for a daemon session lives here, not in a side file, so it is part of the session's
 * durable state and resumes with the session. `Goals` (services/goals.ts) is the write surface.
 */

import { defineDoc } from "@earendil-works/pi-durable";

export type GoalState = {
	active: boolean;
	condition: string;
	verdicts: number;
	lastReason: string;
	/** "" while active; "achieved" | "impossible" | "cleared" once resolved. */
	outcome: string;
	since: number;
	at: number;
};

export const GoalDoc = defineDoc<GoalState>({
	kind: "pi.goal",
	version: 1,
	scope: "session",
	initial: () => ({
		active: false,
		condition: "",
		verdicts: 0,
		lastReason: "",
		outcome: "",
		since: 0,
		at: 0,
	}),
	checkpointWhen: () => true,
});
