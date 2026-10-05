/**
 * `Questions` — session service for answering the durable `pi.question` document.
 *
 * A background agent posts a pending question (`request_input`); any attached client answers it
 * through this service, which commits the answer into the same session-scoped document. The tool
 * then resumes. This is the native write surface for needs-input; `harness.documentState` is
 * read-only and writes only happen inside a commit.
 */

import { type Context, defineService } from "@earendil-works/chord";

export interface QuestionsService {
	/** Answer the session's pending question. `ok: false` when there is no pending question. */
	answer(answer: string, context: Context): Promise<{ readonly ok: boolean; readonly error?: string }>;
}

/** Remote (not local) so the client can reach it. */
export const Questions = defineService<QuestionsService>("pi.questions");
