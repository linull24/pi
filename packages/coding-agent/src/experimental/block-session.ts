/**
 * Session binding for the blackboard — this is the whole A2A surface.
 *
 * A session binds to the shared block store with an **author identity** (`session:<id>`) and a mention
 * router wired to the A2A targets. Then the complete agent-to-agent protocol is:
 *
 *   1. post a block        (everything is a block: turn / instruction / evidence / plan-step)
 *   2. mention `@x`        (public — everyone can see it)
 *   3. whoever is `@`-ed acts; results are posted back as child blocks
 *
 * There is no private channel and no separate delivery system: the block *is* the message, the
 * mention *is* the address, and a query subscription *is* the wake-up.
 */

import {
	captainMentionTarget,
	type MentionFireResult,
	type MentionRouter,
	type SubagentRunResult,
	subagentMentionTarget,
} from "./block-triggers.ts";
import {
	mention as addMention,
	type Block,
	type BlockQuery,
	type BlockStore,
	createBlock,
	query,
	updateBlock,
} from "./blocks.ts";

export interface BlackboardTargets {
	/** Deliver to the captain (the side-channel steer). */
	deliverToCaptain?(text: string, sessionId: string): Promise<void>;
	/** Run a named subagent. */
	runSubagent?(agent: string, task: string): Promise<SubagentRunResult>;
	/** Steer another session by id (`@session:<id>`). */
	steerSession?(sessionId: string, text: string): Promise<void>;
	/** Subagent names that may be `@`-mentioned. */
	readonly agents?: readonly string[];
}

export interface BlackboardBinding {
	readonly sessionId: string;
	readonly store: BlockStore;
	readonly router: MentionRouter;
	/** Post a block authored by this session. */
	post(input: {
		kind: Block["kind"];
		body: string;
		title?: string;
		parent?: string | null;
		props?: Record<string, unknown>;
	}): Block;
	/** Post, mention, then fire the triggers. Returns what fired and what was unknown. */
	ask(input: {
		kind: Block["kind"];
		body: string;
		mentions: readonly string[];
		title?: string;
		parent?: string | null;
		props?: Record<string, unknown>;
	}): Promise<{ block: Block; result: MentionFireResult }>;
	/** Blocks that mention this session — its public inbox, by query. */
	inbox(): readonly Block[];
	/** Close a block (e.g. an instruction that was handled). */
	close(id: string): Block;
}

export interface BindSessionOptions {
	readonly sessionId: string;
	readonly store: BlockStore;
	readonly router: MentionRouter;
	readonly targets?: BlackboardTargets;
	log?(message: string): void;
}

/** Bind a session to a blackboard and wire the default A2A targets. */
export function bindSession(options: BindSessionOptions): BlackboardBinding {
	const { sessionId, store, router } = options;
	const log = options.log ?? (() => {});
	const targets = options.targets ?? {};

	const handles: string[] = [];
	if (targets.deliverToCaptain !== undefined) {
		router.register(
			captainMentionTarget(async (text) => {
				await targets.deliverToCaptain?.(text, sessionId);
			}),
		);
		handles.push("captain");
	}
	for (const agent of targets.agents ?? []) {
		router.register(
			subagentMentionTarget(
				agent,
				async (task) => (await targets.runSubagent?.(agent, task)) ?? { ok: false, error: "no subagent runner" },
			),
		);
		handles.push(agent);
	}
	if (targets.steerSession !== undefined) {
		router.register({
			handle: "session",
			async trigger(context) {
				// `@session:<id>` — the handle carries the target after the colon.
				const target = context.block.mentions.find((m) => m.startsWith("@session:"))?.slice("@session:".length);
				if (target !== undefined && target.length > 0) await targets.steerSession?.(target, context.block.body);
			},
		});
		handles.push("session");
	}
	log(`blackboard bound to session ${sessionId}; targets: ${handles.join(", ") || "none"}`);

	return {
		sessionId,
		store,
		router,
		post(input) {
			return createBlock(store, {
				kind: input.kind,
				body: input.body,
				author: `session:${sessionId}`,
				parent: input.parent ?? null,
				...(input.title === undefined ? {} : { title: input.title }),
				...(input.props === undefined ? {} : { props: input.props }),
			});
		},
		async ask(input) {
			const block = createBlock(store, {
				kind: input.kind,
				body: input.body,
				author: `session:${sessionId}`,
				parent: input.parent ?? null,
				...(input.title === undefined ? {} : { title: input.title }),
				...(input.props === undefined ? {} : { props: input.props }),
			});
			for (const target of input.mentions) addMention(store, block.id, target);
			const current = store.get(block.id) ?? block;
			const result = await router.fire(current, store, log);
			return { block: current, result };
		},
		inbox() {
			return query(store, { mentions: `@session:${sessionId}` });
		},
		close(id) {
			return updateBlock(store, id, { status: "closed" });
		},
	};
}

/** Query helper shared by session code and the future Logseq layer. */
export function queryBlocks(store: BlockStore, q: BlockQuery): readonly Block[] {
	return query(store, q);
}
