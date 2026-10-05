/**
 * Daemon-side binding for the side channel.
 *
 * The transport-agnostic router (`side-channel.ts`) needs three effects per session: read whether a
 * `pi.question` is pending, answer it, and steer the session. The daemon owns the concrete session
 * services (`Questions`, `AgentController`) and hands them in through {@link OpenSessionChannelServices}.
 *
 * Keeping this as a thin adapter means the router stays pure and the daemon supplies the real
 * services, so the pieces can be tested independently.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SideChannelDeps } from "./side-channel.ts";

/** Channel-shaped view of one session's durable services. */
export interface SessionChannelServices {
	hasPendingQuestion(): Promise<boolean>;
	answer(text: string): Promise<{ readonly ok: boolean; readonly error?: string }>;
	steer(text: string): Promise<{ readonly accepted: boolean; readonly error?: string }>;
}

/** Open the channel services for a session id. Supplied by the daemon. */
export type OpenSessionChannelServices = (
	sessionId: string,
) => SessionChannelServices | Promise<SessionChannelServices>;

/** Turn a per-session service opener into the router's injected dependencies. */
export function createSideChannelDeps(open: OpenSessionChannelServices): SideChannelDeps {
	return {
		hasPendingQuestion: async (sessionId) => (await open(sessionId)).hasPendingQuestion(),
		answerQuestion: async (sessionId, text) => (await open(sessionId)).answer(text),
		steer: async (sessionId, text) => (await open(sessionId)).steer(text),
	};
}

/**
 * Build an opener from a session-scoped service source and the two service keys, mirroring how the
 * client opens a session's services (`source.open({ services }).use(Service)`).
 */
export interface SessionServiceSource {
	open(options: { services: readonly { readonly id: string }[]; assertAccess(): void; onError(error: Error): void }): {
		use<T>(service: unknown): T;
		ready(context: unknown): Promise<void>;
	};
}

export interface SessionServiceKeys {
	readonly Questions: { readonly id: string };
	readonly AgentController: { readonly id: string };
}

/**
 * Concrete opener: open the target session's `Questions` / `AgentController`, expose them as
 * channel services. `hasPendingQuestion` is answered by trying to answer nothing — instead the
 * daemon supplies a real read via `readPendingQuestion` when it has one.
 */
export function createSessionChannelOpener(
	source: SessionServiceSource,
	keys: SessionServiceKeys,
	readPendingQuestion: (sessionId: string) => Promise<boolean>,
): OpenSessionChannelServices {
	return (sessionId) => {
		const services = source.open({
			services: [keys.Questions, keys.AgentController],
			assertAccess: () => {},
			onError: () => {},
		});
		const ready = () => services.ready(BACKGROUND_CONTEXT);
		return {
			hasPendingQuestion: () => readPendingQuestion(sessionId),
			answer: async (text: string) => {
				await ready();
				const questions = services.use<{
					answer(text: string): Promise<{ ok: boolean; error?: string }>;
				}>(keys.Questions);
				return questions.answer(text);
			},
			steer: async (text: string) => {
				await ready();
				const controller = services.use<{
					steer(request: {
						message: string;
						images: null;
					}): Promise<{ accepted: boolean; error?: { message: string } | null }>;
				}>(keys.AgentController);
				const result = await controller.steer({ message: text, images: null });
				return result.accepted ? { accepted: true } : { accepted: false, error: result.error?.message };
			},
		};
	};
}
