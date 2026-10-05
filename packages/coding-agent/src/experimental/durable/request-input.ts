/**
 * `request_input` — a durable question/answer primitive for background sessions.
 *
 * A background agent that needs a decision posts the question into a **session-scoped durable
 * document** (`pi.question`) and waits. Any client can read the document (Agent View shows the
 * session as `needs input`) and write the answer back; the tool then resumes. All state lives in
 * the session store — no side files. The wait is bounded by a timeout so a session can never hang.
 */

import { defineDoc, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

type QuestionState = {
	status: "idle" | "pending" | "answered";
	requestId: string;
	question: string;
	options: string[];
	answer: string;
	askedAt: number;
	answeredAt: number;
};

/** Session-scoped durable question. New `kind` in the durable protocol. */
export const QuestionDoc = defineDoc<QuestionState>({
	kind: "pi.question",
	version: 1,
	scope: "session",
	initial: () => ({
		status: "idle",
		requestId: "",
		question: "",
		options: [],
		answer: "",
		askedAt: 0,
		answeredAt: 0,
	}),
	checkpointWhen: () => true,
});

/** How long a question waits before the tool gives up. */
const WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_MS = 1000;

export const RequestInput: Extension = defineExtension({
	name: "request-input",
	tools: [
		defineTool({
			name: "request_input",
			description: [
				"Ask the user a question and wait for their answer (durable).",
				"Use it when background work needs a decision only the user can make.",
				"The question is stored in the session and any attached client can answer it.",
			].join(" "),
			parameters: Type.Object({
				question: Type.String({ description: "The question to ask the user." }),
				options: Type.Optional(Type.Array(Type.String(), { description: "Optional choices to offer." })),
			}),
			replay: "unsafe",
			async execute(args, api, context) {
				const requestId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
				await api.commit(async (tx) => {
					const doc = await tx.doc(QuestionDoc);
					doc.status = "pending";
					doc.requestId = requestId;
					doc.question = args.question;
					doc.options = [...(args.options ?? [])];
					doc.answer = "";
					doc.askedAt = Date.now();
					doc.answeredAt = 0;
				}, context);

				const deadline = Date.now() + WAIT_TIMEOUT_MS;
				while (Date.now() < deadline) {
					const snapshot = await api.commit(async (tx) => {
						const doc = await tx.doc(QuestionDoc);
						return { status: doc.status, requestId: doc.requestId, answer: doc.answer };
					}, context);
					if (snapshot.requestId === requestId && snapshot.status === "answered") {
						await api.commit(async (tx) => {
							const doc = await tx.doc(QuestionDoc);
							doc.status = "idle";
						}, context);
						const answer = snapshot.answer.trim();
						return {
							content: [{ type: "text" as const, text: answer.length > 0 ? answer : "(no answer)" }],
							details: {},
						};
					}
					await new Promise((resolve) => setTimeout(resolve, POLL_MS));
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `No answer to "${args.question}" within ${Math.round(WAIT_TIMEOUT_MS / 60000)} minutes.`,
						},
					],
					isError: true,
					details: {},
				};
			},
		}),
	],
});
