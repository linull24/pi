import type { Conversation } from "@earendil-works/pi-durable";
import { GoalDoc, type GoalState } from "../durable/goal.ts";
import type { GoalsService } from "./goals.ts";

/** Set, clear, or read the session's durable goal by committing to the `pi.goal` document. */
export function createGoalsService(conversation: Conversation): GoalsService {
	return {
		async set(condition, context) {
			await conversation.commit(async (tx) => {
				const doc = await tx.doc(GoalDoc);
				doc.active = true;
				doc.condition = condition;
				doc.verdicts = 0;
				doc.lastReason = "";
				doc.outcome = "";
				doc.since = Date.now();
				doc.at = 0;
			}, context);
			return { ok: true };
		},
		async clear(context) {
			await conversation.commit(async (tx) => {
				const doc = await tx.doc(GoalDoc);
				doc.active = false;
				doc.outcome = "cleared";
				doc.at = Date.now();
			}, context);
			return { ok: true };
		},
		async status(context) {
			return await conversation.commit(async (tx) => {
				const doc = await tx.doc(GoalDoc);
				return {
					active: doc.active,
					condition: doc.condition,
					verdicts: doc.verdicts,
					lastReason: doc.lastReason,
					outcome: doc.outcome,
					since: doc.since,
					at: doc.at,
				} satisfies GoalState;
			}, context);
		},
	};
}
