import type { Conversation } from "@earendil-works/pi-durable";
import { QuestionDoc } from "../durable/request-input.ts";
import type { QuestionsService } from "./questions.ts";

/** Answer the session's pending `pi.question` by committing the answer durably. */
export function createQuestionsService(conversation: Conversation): QuestionsService {
	return {
		async answer(answer, context) {
			try {
				let answered = false;
				await conversation.commit(async (tx) => {
					const doc = await tx.doc(QuestionDoc);
					if (doc.status !== "pending") return;
					doc.answer = answer;
					doc.status = "answered";
					doc.answeredAt = Date.now();
					answered = true;
				}, context);
				return answered ? { ok: true } : { ok: false, error: "no pending question" };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
