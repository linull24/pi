/**
 * `Goals` — session service for the durable `pi.goal` document. Any client can set, clear, or read
 * the session's goal; state is durable and resumes with the session.
 */

import { type Context, defineService } from "@earendil-works/chord";
import type { GoalState } from "../durable/goal.ts";

export interface GoalsService {
	set(condition: string, context: Context): Promise<{ readonly ok: boolean }>;
	clear(context: Context): Promise<{ readonly ok: boolean }>;
	status(context: Context): Promise<GoalState>;
}

/** Remote (not local) so clients can reach it. */
export const Goals = defineService<GoalsService>("pi.goals");
